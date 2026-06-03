// PUT /api/crypto/sendToDevice/:event_type/:txn_id
// Matrix-shaped to-device fan-out. The OlmMachine on the sender's client
// hands us a per-request `txn_id` and a `{ user_id: { device_id: content } }`
// map; we drop one row per (user, device) into user_to_device_queue and the
// recipient drains it via GET /api/crypto/sync.
//
// Idempotency: a single sendToDevice request can produce N queue rows but
// shares one txn_id. The queue's existing UNIQUE on (sender, txn_id) would
// only let the first recipient row land. We track applied txns separately
// in `crypto_sent_txns` (migration 0039), check it up front, and skip the
// whole fan-out if we've already serviced this txn.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { cryptoSentTxns, userToDeviceQueue } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { fromMatrixUserId } from "@/lib/crypto-matrix";

const DEVICE_HEADER = "x-legends-crypto-device-id";

const bodySchema = z.object({
  messages: z.record(
    z.string().min(1).max(256), // matrix user id
    z.record(z.string().min(1).max(128), z.record(z.string(), z.unknown())),
  ),
});

function matrixError(errcode: string, error: string, status: number) {
  return NextResponse.json({ errcode, error }, { status });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ event_type: string; txn_id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return matrixError("M_FORBIDDEN", "unauthorized", 401);
  if (user.isAnon) return matrixError("M_FORBIDDEN", "anon forbidden", 403);

  const senderDeviceId = req.headers.get(DEVICE_HEADER);
  if (!senderDeviceId) {
    return matrixError("M_UNKNOWN", `missing ${DEVICE_HEADER} header`, 400);
  }

  const minute = Math.floor(Date.now() / 60000);
  const rl = await checkAndIncrement(`crypto:s2d:${user.id}:m:${minute}`, 120, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { errcode: "M_LIMIT_EXCEEDED", error: "rate limit exceeded", retry_after_ms: retryAfter * 1000 },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const { event_type: rawEventType, txn_id: rawTxnId } = await params;
  const eventType = decodeURIComponent(rawEventType);
  const txnId = decodeURIComponent(rawTxnId);
  if (!eventType || !txnId || eventType.length > 256 || txnId.length > 256) {
    return matrixError("M_UNKNOWN", "bad path params", 400);
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return matrixError("M_UNKNOWN", `bad body: ${parsed.error.message}`, 400);

  // Idempotency: claim the txn row first. ON CONFLICT DO NOTHING + returning
  // tells us whether we won the insert. If we didn't, the original request
  // was already applied — Matrix expects an empty {} response either way.
  const txnInsert = await db
    .insert(cryptoSentTxns)
    .values({
      senderUserId: user.id,
      senderDeviceId,
      txnId,
    })
    .onConflictDoNothing()
    .returning({ txnId: cryptoSentTxns.txnId });
  if (txnInsert.length === 0) {
    return NextResponse.json({});
  }

  // Fan out queue rows. We pre-resolve every matrix user id and skip any
  // that are malformed (rather than failing the whole request) so a single
  // bad entry can't break otherwise-good sends.
  const rowsToInsert: {
    recipientUserId: string;
    recipientDeviceId: string;
    senderUserId: string;
    senderDeviceId: string;
    eventType: string;
    contentJson: Record<string, unknown>;
    txnId: string;
  }[] = [];

  for (const [matrixUserId, devices] of Object.entries(parsed.data.messages)) {
    const rawUserId = fromMatrixUserId(matrixUserId);
    if (!rawUserId) continue;
    for (const [deviceId, content] of Object.entries(devices)) {
      if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > 128) continue;
      rowsToInsert.push({
        recipientUserId: rawUserId,
        recipientDeviceId: deviceId, // "*" means broadcast to all of the recipient's devices
        senderUserId: user.id,
        senderDeviceId,
        eventType,
        contentJson: content as Record<string, unknown>,
        txnId,
      });
    }
  }

  if (rowsToInsert.length > 0) {
    // Chunk inserts to avoid hitting parameter limits on very large fan-outs.
    const CHUNK = 200;
    for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
      const chunk = rowsToInsert.slice(i, i + CHUNK);
      // We don't onConflictDoNothing here because the queue's UNIQUE on
      // (sender, sender_device, txn_id) would collide on the SECOND row of
      // any fan-out. With the cryptoSentTxns gate above, we should never
      // re-enter this block for the same txn — so a plain insert is correct
      // and any collision is a real bug we want surfaced.
      await db.insert(userToDeviceQueue).values(chunk);
    }
  }

  return NextResponse.json({});
}
