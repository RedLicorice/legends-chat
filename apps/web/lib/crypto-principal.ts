// Dispatch layer: a user-facing /api/crypto/* call against a Matrix id can
// target either a user or a bot principal. This module hides that branch from
// callers — they pass a parsed Principal and we read/write the matching tables.
//
// All five exports below are designed to be the only abstraction the route
// handlers need to talk to. Adding a third principal type (e.g. service
// account) is a matter of widening `Principal` and adding new branches here;
// route handlers stay generic.

import { and, eq, sql } from "drizzle-orm";
import {
  bots,
  botCryptoSentTxns,
  botDevices,
  botOneTimeKeys,
  botToDeviceQueue,
  cryptoSentTxns,
  userKeyBundles,
  userOneTimePrekeys,
  userToDeviceQueue,
} from "@legends/db/schema";
import { db } from "@/lib/db";
import {
  parseMatrixPrincipal,
  type MatrixPrincipal,
} from "@/lib/crypto-matrix";

export type Principal = MatrixPrincipal;

export type DeviceListEntry = {
  deviceId: string;
  algorithms: string[];
  keys: Record<string, string>;
  signatures: Record<string, Record<string, string>> | null;
};

export type DeviceList = { devices: DeviceListEntry[] };

export type OtkRow = {
  keyId: string;
  algorithm: string;
  keyJson: Record<string, unknown>;
};

/** Wrap the matrix-id parser so consumers depend on this module only. */
export function parsePrincipalFromMatrixId(matrixId: string): Principal | null {
  return parseMatrixPrincipal(matrixId);
}

/**
 * Return the published device list for a principal. Routes /api/crypto/keys/query
 * (user-facing) and /api/bot/v1/crypto/keys/query (bot-facing) both hit this.
 */
export async function getDeviceList(p: Principal): Promise<DeviceList> {
  if (p.type === "user") {
    const rows = await db
      .select({
        deviceId: userKeyBundles.deviceId,
        algorithms: userKeyBundles.algorithmsJson,
        keys: userKeyBundles.keysJson,
        signatures: userKeyBundles.signaturesJson,
      })
      .from(userKeyBundles)
      .where(eq(userKeyBundles.userId, p.id));
    return {
      devices: rows.map((r) => ({
        deviceId: r.deviceId,
        algorithms: r.algorithms,
        keys: r.keys,
        signatures: r.signatures,
      })),
    };
  }

  const rows = await db
    .select({
      deviceId: botDevices.deviceId,
      algorithms: botDevices.algorithms,
      identityKeys: botDevices.identityKeys,
      signatures: botDevices.signatures,
    })
    .from(botDevices)
    .where(eq(botDevices.botId, p.id));
  return {
    devices: rows.map((r) => ({
      deviceId: r.deviceId,
      algorithms: r.algorithms,
      keys: r.identityKeys,
      signatures: r.signatures,
    })),
  };
}

/**
 * Atomically claim one unused one-time prekey for (principal, deviceId,
 * algorithm). Uses FOR UPDATE SKIP LOCKED so two concurrent claims never hand
 * out the same key. Returns null when the OTK pool for that (device, alg) is
 * empty — the caller decides whether to fall back to a fallback key.
 */
export async function claimOneTimeKey(
  p: Principal,
  deviceId: string,
  algorithm: string,
): Promise<OtkRow | null> {
  if (p.type === "user") {
    const popped = await db.execute<{
      key_id: string;
      algorithm: string;
      key_json: Record<string, unknown>;
    }>(sql`
      UPDATE user_one_time_prekeys
         SET used_at = now()
       WHERE ctid IN (
         SELECT ctid FROM user_one_time_prekeys
          WHERE user_id = ${p.id}
            AND device_id = ${deviceId}
            AND algorithm = ${algorithm}
            AND used_at IS NULL
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING key_id, algorithm, key_json
    `);
    const row = Array.from(popped)[0];
    return row
      ? { keyId: row.key_id, algorithm: row.algorithm, keyJson: row.key_json }
      : null;
  }

  const popped = await db.execute<{
    key_id: string;
    algorithm: string;
    key_json: Record<string, unknown>;
  }>(sql`
    UPDATE bot_one_time_keys
       SET claimed_at = now()
     WHERE ctid IN (
       SELECT ctid FROM bot_one_time_keys
        WHERE bot_id = ${p.id}
          AND device_id = ${deviceId}
          AND algorithm = ${algorithm}
          AND claimed_at IS NULL
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING key_id, algorithm, key_json
  `);
  const row = Array.from(popped)[0];
  return row
    ? { keyId: row.key_id, algorithm: row.algorithm, keyJson: row.key_json }
    : null;
}

/**
 * Enqueue a to-device envelope. Routes to bot_to_device_queue when the
 * recipient is a bot, user_to_device_queue when the recipient is a user.
 *
 * Bot→user constraint: `user_to_device_queue.sender_user_id` is NOT NULL in
 * the current schema. For bot-sender / user-recipient envelopes we synthesize
 * the row with sender_user_id = bots.ownerUserId and sender_device_id =
 * `bot:<botId>`. The Matrix-side claim of who sent the envelope still lives
 * inside the Olm-wrapped payload, so this only affects server-side bookkeeping.
 *
 * TODO(0046): widen user_to_device_queue to mirror bot_to_device_queue
 * (sender_user_id XOR sender_bot_id) so we can drop the synthesized-owner
 * shim and store the bot id directly.
 */
export async function enqueueToDevice(args: {
  recipient: Principal;
  recipientDeviceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  sender: Principal;
  senderDeviceId?: string;
  txnId?: string;
}): Promise<void> {
  if (args.recipient.type === "bot") {
    await db.insert(botToDeviceQueue).values({
      botId: args.recipient.id,
      deviceId: args.recipientDeviceId,
      eventType: args.eventType,
      senderUserId: args.sender.type === "user" ? args.sender.id : null,
      senderBotId: args.sender.type === "bot" ? args.sender.id : null,
      payload: args.payload,
    });
    return;
  }

  // Recipient is a user → user_to_device_queue.
  let senderUserId: string;
  let senderDeviceId: string;

  if (args.sender.type === "user") {
    senderUserId = args.sender.id;
    senderDeviceId = args.senderDeviceId ?? "session";
  } else {
    // Bot sender → resolve owner to satisfy NOT NULL on sender_user_id.
    // See TODO(0046) above; this is the documented workaround.
    const [owner] = await db
      .select({ ownerUserId: bots.ownerUserId })
      .from(bots)
      .where(eq(bots.id, args.sender.id))
      .limit(1);
    if (!owner) {
      throw new Error(`enqueueToDevice: unknown bot sender ${args.sender.id}`);
    }
    senderUserId = owner.ownerUserId;
    senderDeviceId = args.senderDeviceId ?? `bot:${args.sender.id}`;
  }

  await db.insert(userToDeviceQueue).values({
    recipientUserId: args.recipient.id,
    recipientDeviceId: args.recipientDeviceId,
    senderUserId,
    senderDeviceId,
    eventType: args.eventType,
    contentJson: args.payload,
    txnId:
      args.txnId ??
      `dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
}

/**
 * Per-(sender, txn_id) idempotency. Returns:
 *   - { stored: true,  conflict: false } — fresh insert; caller should proceed.
 *   - { stored: false, conflict: false } — exact replay; caller should no-op.
 *   - { stored: false, conflict: true  } — same txn_id but different body hash;
 *       caller should reject as a malformed retry.
 *
 * The user-sender branch uses the legacy `crypto_sent_txns` table, which does
 * not track body_hash. Body conflicts there are therefore always reported as
 * false — that table's role is "did we see this txn before" only. Bot senders
 * use `bot_crypto_sent_txns`, which does track body_hash.
 */
export async function idempotencyCheck(
  sender: Principal,
  txnId: string,
  eventType: string,
  bodyHash: Buffer,
): Promise<{ stored: boolean; conflict: boolean }> {
  if (sender.type === "bot") {
    const inserted = await db
      .insert(botCryptoSentTxns)
      .values({
        botId: sender.id,
        txnId,
        eventType,
        bodyHash,
      })
      .onConflictDoNothing()
      .returning({ txnId: botCryptoSentTxns.txnId });
    if (inserted.length > 0) return { stored: true, conflict: false };
    const [existing] = await db
      .select({ bodyHash: botCryptoSentTxns.bodyHash })
      .from(botCryptoSentTxns)
      .where(
        and(eq(botCryptoSentTxns.botId, sender.id), eq(botCryptoSentTxns.txnId, txnId)),
      )
      .limit(1);
    const conflict =
      !!existing &&
      !Buffer.from(existing.bodyHash as Uint8Array).equals(bodyHash);
    return { stored: false, conflict };
  }

  // User sender: legacy crypto_sent_txns is keyed on (sender_user_id,
  // sender_device_id, txn_id) — there is no body_hash column today, so we
  // can detect replay but not body-hash conflicts. Tracked as a follow-up;
  // user-side sendToDevice did not previously distinguish either.
  const inserted = await db
    .insert(cryptoSentTxns)
    .values({
      senderUserId: sender.id,
      senderDeviceId: "session",
      txnId,
    })
    .onConflictDoNothing()
    .returning({ txnId: cryptoSentTxns.txnId });
  return { stored: inserted.length > 0, conflict: false };
}
