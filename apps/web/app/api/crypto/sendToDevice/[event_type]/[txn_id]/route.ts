// PUT /api/crypto/sendToDevice/:event_type/:txn_id
// Matrix-shaped to-device fan-out. The OlmMachine on the sender's client
// hands us a per-request `txn_id` and a `{ matrix_id: { device_id: content } }`
// map; we drop one row per (recipient, device) into whichever queue matches
// the recipient principal type:
//   - user recipient → user_to_device_queue
//   - bot recipient  → bot_to_device_queue (sender_user_id = caller, no bot
//                      sender column populated since sender is a user)
// The recipient drains the appropriate queue via its sync endpoint.
//
// Idempotency: a single sendToDevice request can produce N queue rows but
// shares one txn_id. The queue's existing UNIQUE on (sender, txn_id) would
// only let the first recipient row land. We track applied txns separately
// in `crypto_sent_txns` (migration 0039), check it up front, and skip the
// whole fan-out if we've already serviced this txn. Sender is always a user
// here, so `crypto_sent_txns` (user-side) is the right idempotency table.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  botToDeviceQueue,
  cryptoSentTxns,
  userKeyBundles,
  userToDeviceQueue,
} from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { parsePrincipalFromMatrixId } from "@/lib/crypto-principal";

const DEVICE_HEADER = "x-legends-crypto-device-id";

const bodySchema = z.object({
  messages: z.record(
    z.string().min(1).max(256), // matrix id (user or bot namespace)
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

  // Provenance binding (#16): the sender device id is stored verbatim and later
  // regex-parsed by /sync to attribute the envelope's sender. Reject any value
  // that isn't one of the caller's OWN registered devices — otherwise a user
  // could set the header to `bot:<uuid>` (or any device id) and forge the
  // apparent origin. Cryptographic identity is still Olm-bound; this closes the
  // provenance/audit-spoof gap.
  const [ownDevice] = await db
    .select({ deviceId: userKeyBundles.deviceId })
    .from(userKeyBundles)
    .where(and(eq(userKeyBundles.userId, user.id), eq(userKeyBundles.deviceId, senderDeviceId)))
    .limit(1);
  if (!ownDevice) {
    return matrixError("M_FORBIDDEN", "sender device not registered to caller", 403);
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

  // Fan out per principal type. Unparseable matrix ids are skipped (rather
  // than failing the whole request) so a single bad entry can't break
  // otherwise-good sends — same forgiveness rule as the pre-dispatch route.
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
          // "*" means broadcast to all of the recipient's devices.
          recipientDeviceId: deviceId,
          senderUserId: user.id,
          senderDeviceId,
          eventType,
          contentJson: content as Record<string, unknown>,
          txnId,
        });
      } else {
        botRows.push({
          botId: principal.id,
          deviceId,
          eventType,
          // Sender is always a user on this user-facing route — the bot-side
          // sender path lives under /api/bot/v1/crypto/sendToDevice.
          senderUserId: user.id,
          senderBotId: null,
          payload: content as Record<string, unknown>,
        });
      }
    }
  }

  // Chunk inserts to avoid hitting parameter limits on very large fan-outs.
  // We don't onConflictDoNothing here because the queue's UNIQUE on
  // (sender, sender_device, txn_id) would collide on the SECOND row of any
  // fan-out. With the cryptoSentTxns gate above, we should never re-enter
  // this block for the same txn — so a plain insert is correct and any
  // collision is a real bug we want surfaced.
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
