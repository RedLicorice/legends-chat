// GET /api/crypto/sync?since=<iso>&device_id=<deviceId>
// Minimal Matrix /sync-shaped drain: returns to-device events queued for the
// caller's (user, device), along with the per-device OTK count and fallback
// availability so OlmMachine knows when to top up keys.
//
// `since` is the ISO timestamp of the last row the caller saw; missing or
// empty drains from the start. We mark drained rows delivered_at = now()
// in a follow-up UPDATE so a future TTL cleanup can prune them.

import { NextResponse, type NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { userKeyBundles, userToDeviceQueue } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";

const PAGE_SIZE = 200;
const EPOCH = new Date(0).toISOString();

function matrixError(errcode: string, error: string, status: number) {
  return NextResponse.json({ errcode, error }, { status });
}

const deviceIdSchema = z.string().min(1).max(128);

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return matrixError("M_FORBIDDEN", "unauthorized", 401);
  if (user.isAnon) return matrixError("M_FORBIDDEN", "anon forbidden", 403);

  // Active polling — higher than the upload/query/claim cap.
  const minute = Math.floor(Date.now() / 60000);
  const rl = await checkAndIncrement(`crypto:sync:${user.id}:m:${minute}`, 240, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { errcode: "M_LIMIT_EXCEEDED", error: "rate limit exceeded", retry_after_ms: retryAfter * 1000 },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const { searchParams } = new URL(req.url);
  const deviceParsed = deviceIdSchema.safeParse(searchParams.get("device_id") ?? "");
  if (!deviceParsed.success) {
    return matrixError("M_UNKNOWN", "missing or invalid device_id", 400);
  }
  const deviceId = deviceParsed.data;

  // Parse since cursor. We treat anything unparseable as epoch start rather
  // than failing — clients can recover by simply continuing.
  const sinceRaw = searchParams.get("since") ?? "";
  let since: Date;
  if (!sinceRaw) {
    since = new Date(0);
  } else {
    const parsed = new Date(sinceRaw);
    since = Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  }

  // Pull queued to-device events for THIS user where the device matches
  // OR the recipient_device_id is "*" (broadcast).
  //
  // CURSOR PRECISION NOTE: Postgres `timestamptz` is microsecond-precision but
  // JS Date / ISO strings only carry millisecond precision. If we filter raw
  // `created_at > $since` against the cursor we round-tripped through JS, any
  // sub-millisecond fraction makes the row match again next poll → infinite
  // loop. We truncate both sides to milliseconds to make the cursor stable.
  const rows = await db.execute<{
    id: string;
    sender_user_id: string;
    sender_device_id: string;
    event_type: string;
    content_json: Record<string, unknown>;
    created_at_ms: Date;
  }>(sql`
    SELECT id, sender_user_id, sender_device_id, event_type, content_json,
           date_trunc('milliseconds', created_at) AS created_at_ms
      FROM user_to_device_queue
     WHERE recipient_user_id = ${user.id}
       AND (recipient_device_id = ${deviceId} OR recipient_device_id = '*')
       AND date_trunc('milliseconds', created_at) > ${since.toISOString()}
     ORDER BY created_at ASC
     LIMIT ${PAGE_SIZE}
  `);

  const events: { type: string; sender: string; content: Record<string, unknown> }[] = [];
  const ids: string[] = [];
  let lastCreatedAt: Date | null = null;

  // Detect the bot-origin workaround pattern committed in 314e3bf: when the
  // sender is a bot, /api/crypto/sendToDevice writes
  //   sender_user_id  = bots.owner_user_id (NOT NULL column)
  //   sender_device_id = `bot:<botId>`
  // because user_to_device_queue has no sender_bot_id column yet (deferred
  // migration 0046 per R1/INDEX). The outer envelope `sender` MUST match the
  // identity that owns the inner Olm sender_key, otherwise matrix-sdk-crypto
  // silently drops the wrapped m.room_key → bot replies render as "Locked".
  const BOT_ORIGIN_DEVICE_RE = /^bot:([0-9a-fA-F-]+)$/;
  for (const row of Array.from(rows)) {
    const botMatch = row.sender_device_id?.match(BOT_ORIGIN_DEVICE_RE);
    const sender = botMatch
      ? toMatrixBotId(botMatch[1]!)
      : toMatrixUserId(row.sender_user_id);
    events.push({
      type: row.event_type,
      sender,
      content: row.content_json,
    });
    ids.push(row.id);
    const at = row.created_at_ms instanceof Date ? row.created_at_ms : new Date(row.created_at_ms);
    if (!lastCreatedAt || at > lastCreatedAt) lastCreatedAt = at;
  }

  // Best-effort mark-delivered. Failure here is non-fatal; the row will just
  // be returned again on the next sync (the cursor still advances, so the
  // client itself dedupes if needed). We use an array param via sql.array.
  if (ids.length > 0) {
    await db
      .update(userToDeviceQueue)
      .set({ deliveredAt: new Date() })
      .where(sql`${userToDeviceQueue.id} IN ${ids}`);
  }

  // Per-device OTK count + fallback availability so OlmMachine can decide
  // when to upload more keys without an extra round-trip.
  const otkCountRows = await db.execute<{ n: string | number }>(sql`
    SELECT COUNT(*)::int AS n
      FROM user_one_time_prekeys
     WHERE user_id = ${user.id}
       AND device_id = ${deviceId}
       AND algorithm = 'signed_curve25519'
       AND used_at IS NULL
  `);
  const unusedOtkCount = Number(Array.from(otkCountRows)[0]?.n ?? 0);

  const [bundle] = await db
    .select({ fallback: userKeyBundles.fallbackKeyJson })
    .from(userKeyBundles)
    .where(and(eq(userKeyBundles.userId, user.id), eq(userKeyBundles.deviceId, deviceId)))
    .limit(1);
  const hasFallback =
    !!bundle?.fallback && typeof bundle.fallback === "object" && Object.keys(bundle.fallback).length > 0;

  // device_lists.changed: every user whose device set materially changed
  // since `since`. OlmMachine uses this to invalidate cached device lists
  // and re-query /keys/query for affected users. Capped at 200/sync so a
  // huge churn doesn't blow the payload — the client keeps draining via
  // the advancing cursor.
  //
  // CURSOR PRECISION: `changed_at` is timestamptz (microsecond precision in
  // Postgres) but the cursor we hand back is an ISO string (millisecond
  // precision in JS). If we filter raw `changed_at > $since`, a row stamped
  // e.g. `12:34:56.123456` truncates to `12:34:56.123Z` in next_batch, then
  // `.123456 > .123000` matches again → OlmMachine re-queries forever and
  // hits the 60/min keys/query rate cap. Truncate both sides to milliseconds
  // for a stable, monotonic cursor. Also DISTINCT ON dedups multiple log rows
  // for the same user_id so a noisy user only appears once.
  const changeRows = await db.execute<{ user_id: string; changed_at_ms: Date | string }>(sql`
    SELECT DISTINCT ON (user_id) user_id,
           date_trunc('milliseconds', changed_at) AS changed_at_ms
      FROM user_device_change_log
     WHERE date_trunc('milliseconds', changed_at) > ${since.toISOString()}
     ORDER BY user_id, changed_at DESC
     LIMIT 200
  `);
  const seenChanged = new Set<string>();
  const changedUserIds: string[] = [];
  let maxChangedAt: Date | null = null;
  for (const row of Array.from(changeRows)) {
    const mxid = toMatrixUserId(row.user_id);
    if (!seenChanged.has(mxid)) {
      seenChanged.add(mxid);
      changedUserIds.push(mxid);
    }
    const at = row.changed_at_ms instanceof Date ? row.changed_at_ms : new Date(row.changed_at_ms);
    if (!maxChangedAt || at > maxChangedAt) maxChangedAt = at;
  }

  // next_batch advances to whichever watermark is later: the last to-device
  // row delivered, or the latest device-change row we surfaced. Falling back
  // to the incoming cursor (or EPOCH) keeps idempotent re-polls cheap.
  const candidates: Date[] = [];
  if (lastCreatedAt) candidates.push(lastCreatedAt);
  if (maxChangedAt) candidates.push(maxChangedAt);
  const nextBatch = candidates.length > 0
    ? new Date(Math.max(...candidates.map((d) => d.getTime()))).toISOString()
    : sinceRaw || EPOCH;

  return NextResponse.json({
    next_batch: nextBatch,
    to_device: { events },
    device_lists: { changed: changedUserIds, left: [] },
    device_one_time_keys_count: { signed_curve25519: unusedOtkCount },
    device_unused_fallback_key_types: hasFallback ? ["signed_curve25519"] : [],
  });
}
