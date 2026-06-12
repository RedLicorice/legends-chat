// GET /api/bot/v1/crypto/sync?timeout=<ms>
//
// Bot-authenticated drain of bot_to_device_queue + per-algorithm unclaimed
// OTK count, mirroring user-side /api/crypto/sync. The route long-polls up
// to `timeout` ms (default 30s) for new envelopes, then drains them atomically
// via DELETE … RETURNING so a poll-and-delete cycle can't lose rows.
//
// Long-poll strategy: lightweight 200ms postgres polls. There is no Redis
// notification on bot_to_device_queue today (writes come from /api/crypto/sendToDevice
// and /api/bot/v1/crypto/sendToDevice, both direct INSERTs). When that
// notification channel is added, this route should subscribe to it and wake
// immediately rather than poll — but the poll cost is trivial at the current
// bot density.

import { NextResponse } from "next/server";
import { sql, eq, and, isNull } from "drizzle-orm";
import { botOneTimeKeys } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";
import { toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";

export const maxDuration = 35;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;
const DRAIN_LIMIT = 200;

type DrainedRow = {
  device_id: string;
  event_type: string;
  sender_user_id: string | null;
  sender_bot_id: string | null;
  payload: Record<string, unknown>;
};

async function drain(botId: string): Promise<DrainedRow[]> {
  const result = await db.execute<DrainedRow>(sql`
    DELETE FROM bot_to_device_queue
     WHERE id IN (
       SELECT id FROM bot_to_device_queue
        WHERE bot_id = ${botId}
        ORDER BY id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${DRAIN_LIMIT}
     )
     RETURNING device_id, event_type, sender_user_id, sender_bot_id, payload
  `);
  return Array.from(result);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) {
    return NextResponse.json(
      { errcode: "unauthorized", error: "unauthorized" },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const rawTimeout = url.searchParams.get("timeout");
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout !== null) {
    const n = Number(rawTimeout);
    if (Number.isFinite(n) && n >= 0) {
      timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.floor(n));
    }
  }

  // Long-poll: try to drain immediately; if empty, sleep + retry until the
  // timeout budget is exhausted. We return on the FIRST non-empty drain so
  // callers see latency proportional to queue arrival, not the timeout cap.
  const deadline = Date.now() + timeoutMs;
  let drained: DrainedRow[] = await drain(bot.id);
  while (drained.length === 0 && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    if (Date.now() >= deadline) break;
    drained = await drain(bot.id);
  }

  const events: { type: string; sender: string; content: Record<string, unknown> }[] = [];
  for (const row of drained) {
    const sender = row.sender_bot_id
      ? toMatrixBotId(row.sender_bot_id)
      : row.sender_user_id
        ? toMatrixUserId(row.sender_user_id)
        : "@unknown:legends.local";
    events.push({ type: row.event_type, sender, content: row.payload });
  }

  // Per-algorithm unclaimed OTK count so the bot SDK knows when to top up.
  const otks = await db
    .select({ algorithm: botOneTimeKeys.algorithm })
    .from(botOneTimeKeys)
    .where(and(eq(botOneTimeKeys.botId, bot.id), isNull(botOneTimeKeys.claimedAt)));
  const counts: Record<string, number> = {};
  for (const r of otks) counts[r.algorithm] = (counts[r.algorithm] ?? 0) + 1;

  return NextResponse.json({
    to_device: { events },
    device_one_time_keys_count: counts,
  });
}
