// PUT /api/bot/v1/crypto/sendToDevice/:event_type/:txn_id
//
// Task 10: bot-authenticated to-device fan-out. The bot signs in via its
// bearer token; the route resolves the bot principal, parses the per-recipient
// matrix-id map, and routes each row to either user_to_device_queue (user
// recipient) or bot_to_device_queue (bot recipient). Idempotency uses
// bot_crypto_sent_txns and tracks the body hash so a replay with the same
// (txn_id, hash) is a no-op while a different body for the same txn_id is a
// 409 — see `idempotencyCheck` in lib/crypto-principal.
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PUT } from "@/app/api/bot/v1/crypto/sendToDevice/[event_type]/[txn_id]/route";
import { db } from "@/lib/db";
import {
  bots,
  botDevices,
  botToDeviceQueue,
  userKeyBundles,
  userToDeviceQueue,
} from "@legends/db/schema";

let token: string;
let botId: string;
let peerUserId: string;
let peerBotId: string;

async function send(eventType: string, txnId: string, body: unknown): Promise<Response> {
  return PUT(
    new Request(`http://t/bot/v1/crypto/sendToDevice/${eventType}/${txnId}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ event_type: eventType, txn_id: txnId }) },
  );
}

describe("/api/bot/v1/crypto/sendToDevice", () => {
  beforeAll(async () => {
    const ownerId = randomUUID();
    peerUserId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'bs2d'), (${peerUserId}, 'bs2d-peer') ON CONFLICT DO NOTHING`,
    );
    await db.insert(userKeyBundles).values({
      userId: peerUserId,
      deviceId: "UDD",
      identityPublicKey: "ed",
      algorithmsJson: ["a"],
      keysJson: { "ed25519:UDD": "ed" },
      signaturesJson: { [`@${peerUserId}:legends.local`]: { "ed25519:UDD": "s" } },
    });
    token = randomBytes(16).toString("hex");
    const [b1] = await db
      .insert(bots)
      .values({
        name: `bs2d-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: ownerId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
      })
      .returning({ id: bots.id });
    botId = b1!.id;
    const [b2] = await db
      .insert(bots)
      .values({
        name: `bs2d-peer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: ownerId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      })
      .returning({ id: bots.id });
    peerBotId = b2!.id;
    await db.insert(botDevices).values({
      botId: peerBotId,
      deviceId: "PBD",
      algorithms: ["a"],
      identityKeys: { "ed25519:PBD": "ed" },
    });
  });

  it("bot → user lands in user_to_device_queue", async () => {
    const txn = `tu-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res = await send("m.room.encrypted", txn, {
      messages: { [`@${peerUserId}:legends.local`]: { UDD: { type: "m.room.encrypted", ciphertext: "u1" } } },
    });
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(userToDeviceQueue)
      .where(sql`${userToDeviceQueue.recipientUserId} = ${peerUserId} AND ${userToDeviceQueue.txnId} = ${txn}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientDeviceId).toBe("UDD");
    expect(rows[0]!.senderDeviceId).toBe(`bot:${botId}`);
  });

  it("bot → bot lands in bot_to_device_queue with sender_bot_id set", async () => {
    const txn = `tb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const beforeCount = (
      await db.select().from(botToDeviceQueue).where(sql`${botToDeviceQueue.botId} = ${peerBotId}`)
    ).length;
    const res = await send("m.room.encrypted", txn, {
      messages: { [`@bot.${peerBotId}:legends.local`]: { PBD: { type: "m.room.encrypted", x: "b1" } } },
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(botToDeviceQueue).where(sql`${botToDeviceQueue.botId} = ${peerBotId}`);
    expect(rows.length).toBe(beforeCount + 1);
    const last = rows[rows.length - 1]!;
    expect(last.senderBotId).toBe(botId);
    expect(last.senderUserId).toBeNull();
    expect(last.deviceId).toBe("PBD");
  });

  it("replay with same body returns 200 + does not duplicate", async () => {
    const txn = `tr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = {
      messages: { [`@bot.${peerBotId}:legends.local`]: { PBD: { type: "m.room.encrypted", x: 1 } } },
    };
    const first = await send("m.room.encrypted", txn, body);
    expect(first.status).toBe(200);
    const before = (
      await db.select().from(botToDeviceQueue).where(sql`${botToDeviceQueue.botId} = ${peerBotId}`)
    ).length;
    const second = await send("m.room.encrypted", txn, body);
    expect(second.status).toBe(200);
    const after = (
      await db.select().from(botToDeviceQueue).where(sql`${botToDeviceQueue.botId} = ${peerBotId}`)
    ).length;
    expect(after).toBe(before);
  });

  it("replay with different body returns 409", async () => {
    const txn = `tc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const r1 = await send("m.room.encrypted", txn, {
      messages: { [`@bot.${peerBotId}:legends.local`]: { PBD: { x: 1 } } },
    });
    expect(r1.status).toBe(200);
    const r2 = await send("m.room.encrypted", txn, {
      messages: { [`@bot.${peerBotId}:legends.local`]: { PBD: { x: 2 } } },
    });
    expect(r2.status).toBe(409);
  });

  it("missing bearer returns 401", async () => {
    const txn = `t-401-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res = await PUT(
      new Request(`http://t/bot/v1/crypto/sendToDevice/m.room.encrypted/${txn}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: {} }),
      }),
      { params: Promise.resolve({ event_type: "m.room.encrypted", txn_id: txn }) },
    );
    expect(res.status).toBe(401);
  });
});
