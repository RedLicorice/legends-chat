// PUT /api/bot/v1/crypto/sendToDevice/:event_type/:txn_id
//
// Bot-authenticated mirror of /api/crypto/sendToDevice. The bot uses this to
// hand the server a `{ matrix_id: { device_id: content } }` map; the route
// fans out one row per (recipient, device) to the matching queue:
//   - user recipient → user_to_device_queue
//   - bot recipient  → bot_to_device_queue (sender_bot_id = caller)
//
// Idempotency lives in `bot_crypto_sent_txns` keyed on (bot_id, txn_id) and
// tracks the body sha256 so a replay with the same hash is a 200 no-op,
// while a replay with a different hash is rejected with 409.
//
// Bot→user envelopes don't have a sender_bot_id column on user_to_device_queue
// today, so `enqueueToDevice` synthesizes sender_user_id = bots.ownerUserId
// and sender_device_id = `bot:<botId>`. The Matrix-side identity of the sender
// still lives inside the Olm-wrapped payload, so this is server bookkeeping
// only; see lib/crypto-principal.ts for the TODO(0046) note on widening the
// queue schema.

import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { bots, botToDeviceQueue, userToDeviceQueue } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";
import {
  idempotencyCheck,
  parsePrincipalFromMatrixId,
} from "@/lib/crypto-principal";

const bodySchema = z.object({
  messages: z.record(
    z.string().min(1).max(256),
    z.record(z.string().min(1).max(128), z.record(z.string(), z.unknown())),
  ),
});

export async function PUT(
  req: NextRequest | Request,
  { params }: { params: Promise<{ event_type: string; txn_id: string }> },
) {
  const bot = await getBotFromRequest(req);
  if (!bot) {
    return NextResponse.json(
      { errcode: "unauthorized", error: "unauthorized" },
      { status: 401 },
    );
  }

  const { event_type: rawEventType, txn_id: rawTxnId } = await params;
  const eventType = decodeURIComponent(rawEventType);
  const txnId = decodeURIComponent(rawTxnId);
  if (!eventType || !txnId || eventType.length > 256 || txnId.length > 256) {
    return NextResponse.json(
      { errcode: "bad_path", error: "bad path params" },
      { status: 400 },
    );
  }

  // We need the raw request body twice: once to hash for idempotency, once to
  // JSON.parse for the fan-out. NextRequest.text() consumes the stream, so we
  // read text first and parse manually.
  const rawBody = await req.text();
  let json: unknown;
  try {
    json = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    return NextResponse.json(
      { errcode: "bad_body", error: "invalid JSON" },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { errcode: "bad_body", error: parsed.error.message },
      { status: 400 },
    );
  }

  // Idempotency: bot_crypto_sent_txns is keyed on (bot_id, txn_id) and stores
  // the body hash. Three outcomes from idempotencyCheck:
  //   - stored=true            → fresh insert, proceed with fan-out
  //   - stored=false, conflict=true  → same txn_id, different body → 409
  //   - stored=false, conflict=false → exact replay, return 200 no-op
  const bodyHash = createHash("sha256").update(rawBody).digest();
  const idem = await idempotencyCheck(
    { type: "bot", id: bot.id },
    txnId,
    eventType,
    bodyHash,
  );
  if (!idem.stored) {
    if (idem.conflict) {
      return NextResponse.json(
        { errcode: "txn_conflict", error: "different body for same txn_id" },
        { status: 409 },
      );
    }
    return NextResponse.json({});
  }

  // Owner is needed once to synthesize sender_user_id on bot→user rows
  // (user_to_device_queue.sender_user_id is NOT NULL today).
  const [owner] = await db
    .select({ ownerUserId: bots.ownerUserId })
    .from(bots)
    .where(eq(bots.id, bot.id))
    .limit(1);
  if (!owner) {
    return NextResponse.json(
      { errcode: "internal", error: "bot owner not found" },
      { status: 500 },
    );
  }

  const userRows: (typeof userToDeviceQueue.$inferInsert)[] = [];
  const botRows: (typeof botToDeviceQueue.$inferInsert)[] = [];

  for (const [matrixId, devices] of Object.entries(parsed.data.messages)) {
    const principal = parsePrincipalFromMatrixId(matrixId);
    if (!principal) continue;
    for (const [deviceId, content] of Object.entries(devices)) {
      if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > 128) {
        continue;
      }
      if (principal.type === "user") {
        userRows.push({
          recipientUserId: principal.id,
          recipientDeviceId: deviceId,
          senderUserId: owner.ownerUserId,
          senderDeviceId: `bot:${bot.id}`,
          eventType,
          contentJson: content as Record<string, unknown>,
          txnId,
        });
      } else {
        botRows.push({
          botId: principal.id,
          deviceId,
          eventType,
          senderUserId: null,
          senderBotId: bot.id,
          payload: content as Record<string, unknown>,
        });
      }
    }
  }

  const CHUNK = 200;
  if (userRows.length > 0) {
    for (let i = 0; i < userRows.length; i += CHUNK) {
      await db.insert(userToDeviceQueue).values(userRows.slice(i, i + CHUNK));
    }
  }
  if (botRows.length > 0) {
    for (let i = 0; i < botRows.length; i += CHUNK) {
      await db.insert(botToDeviceQueue).values(botRows.slice(i, i + CHUNK));
    }
  }

  return NextResponse.json({});
}
