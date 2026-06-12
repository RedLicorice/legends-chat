// /api/crypto/sendToDevice — bot-recipient dispatch.
//
// Task 6: today the route only fans out to user_to_device_queue. When a
// matrix id parses as a bot principal, the row should land in
// bot_to_device_queue with sender_user_id = the user and sender_bot_id = null.
// Idempotency continues to live in crypto_sent_txns (sender is still a user).
import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

const FAKE_USER_ID = randomUUID();

vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({
    id: FAKE_USER_ID,
    role: "user",
    permissions: new Set<string>(),
    displayName: "s2d-tester",
    avatarUrl: null,
    isAnon: false,
    presenceOptOut: false,
  }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkAndIncrement: async () => ({
    allowed: true,
    remaining: 119,
    resetAt: Date.now() + 60_000,
  }),
}));

const { PUT } = await import(
  "@/app/api/crypto/sendToDevice/[event_type]/[txn_id]/route"
);
const { db } = await import("@/lib/db");
const { bots, botDevices, botToDeviceQueue, userKeyBundles, userToDeviceQueue } =
  await import("@legends/db/schema");

async function send(
  eventType: string,
  txnId: string,
  body: unknown,
): Promise<Response> {
  return PUT(
    new Request(`http://t/sendToDevice/${eventType}/${txnId}`, {
      method: "PUT",
      headers: { "x-legends-crypto-device-id": "USRDEV" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ event_type: eventType, txn_id: txnId }) },
  );
}

describe("/api/crypto/sendToDevice — bot recipient dispatch", () => {
  let botId: string;
  let peerUserId: string;

  beforeAll(async () => {
    peerUserId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${FAKE_USER_ID}, 's2d-tester'), (${peerUserId}, 's2d-peer') ON CONFLICT DO NOTHING`,
    );
    const [b] = await db
      .insert(bots)
      .values({
        name: `s2d-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: FAKE_USER_ID,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      })
      .returning({ id: bots.id });
    botId = b!.id;
    await db.insert(botDevices).values({
      botId,
      deviceId: "BDEV1",
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
      identityKeys: { "ed25519:BDEV1": "edpk-b" },
    });
    await db.insert(userKeyBundles).values({
      userId: peerUserId,
      deviceId: "PDEV1",
      identityPublicKey: "edpk",
      algorithmsJson: ["m.olm.v1.curve25519-aes-sha2"],
      keysJson: { "ed25519:PDEV1": "edpk" },
      signaturesJson: {
        [`@${peerUserId}:legends.local`]: { "ed25519:PDEV1": "sig" },
      },
    });
  });

  it("routes a bot recipient to bot_to_device_queue", async () => {
    const txnId = `t-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const beforeRows = await db
      .select()
      .from(botToDeviceQueue)
      .where(sql`${botToDeviceQueue.botId} = ${botId}`);
    const res = await send("m.room.encrypted", txnId, {
      messages: {
        [`@bot.${botId}:legends.local`]: {
          BDEV1: { type: "m.room.encrypted", ciphertext: "deadbeef" },
        },
      },
    });
    expect(res.status).toBe(200);
    const afterRows = await db
      .select()
      .from(botToDeviceQueue)
      .where(sql`${botToDeviceQueue.botId} = ${botId}`);
    expect(afterRows.length).toBe(beforeRows.length + 1);
    const newRow = afterRows[afterRows.length - 1]!;
    expect(newRow.senderUserId).toBe(FAKE_USER_ID);
    expect(newRow.senderBotId).toBeNull();
    expect(newRow.deviceId).toBe("BDEV1");
    expect(newRow.eventType).toBe("m.room.encrypted");
    expect(newRow.payload).toMatchObject({ ciphertext: "deadbeef" });
  });

  it("routes a user recipient to user_to_device_queue (no bot rows added)", async () => {
    const txnId = `t-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const beforeBot = await db
      .select()
      .from(botToDeviceQueue)
      .where(sql`${botToDeviceQueue.botId} = ${botId}`);
    const res = await send("m.room.encrypted", txnId, {
      messages: {
        [`@${peerUserId}:legends.local`]: {
          PDEV1: { type: "m.room.encrypted", ciphertext: "u-deadbeef" },
        },
      },
    });
    expect(res.status).toBe(200);
    const userRows = await db
      .select()
      .from(userToDeviceQueue)
      .where(
        sql`${userToDeviceQueue.recipientUserId} = ${peerUserId} AND ${userToDeviceQueue.txnId} = ${txnId}`,
      );
    expect(userRows.length).toBe(1);
    expect(userRows[0]!.recipientDeviceId).toBe("PDEV1");
    const afterBot = await db
      .select()
      .from(botToDeviceQueue)
      .where(sql`${botToDeviceQueue.botId} = ${botId}`);
    expect(afterBot.length).toBe(beforeBot.length);
  });

  it("mixed batch fans out to both queues", async () => {
    const txnId = `t-mix-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const beforeBot = (
      await db
        .select()
        .from(botToDeviceQueue)
        .where(sql`${botToDeviceQueue.botId} = ${botId}`)
    ).length;
    const res = await send("m.room.encrypted", txnId, {
      messages: {
        [`@bot.${botId}:legends.local`]: {
          BDEV1: { type: "m.room.encrypted", ciphertext: "mix-bot" },
        },
        [`@${peerUserId}:legends.local`]: {
          PDEV1: { type: "m.room.encrypted", ciphertext: "mix-user" },
        },
      },
    });
    expect(res.status).toBe(200);
    const afterBot = (
      await db
        .select()
        .from(botToDeviceQueue)
        .where(sql`${botToDeviceQueue.botId} = ${botId}`)
    ).length;
    const userRows = await db
      .select()
      .from(userToDeviceQueue)
      .where(
        sql`${userToDeviceQueue.recipientUserId} = ${peerUserId} AND ${userToDeviceQueue.txnId} = ${txnId}`,
      );
    expect(afterBot).toBe(beforeBot + 1);
    expect(userRows.length).toBe(1);
  });

  it("replay with same txn_id is idempotent (200 no-op, no second row)", async () => {
    const txnId = `t-replay-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const first = await send("m.room.encrypted", txnId, {
      messages: {
        [`@bot.${botId}:legends.local`]: {
          BDEV1: { type: "m.room.encrypted", ciphertext: "first" },
        },
      },
    });
    expect(first.status).toBe(200);
    const afterFirst = (
      await db
        .select()
        .from(botToDeviceQueue)
        .where(sql`${botToDeviceQueue.botId} = ${botId}`)
    ).length;

    const second = await send("m.room.encrypted", txnId, {
      messages: {
        [`@bot.${botId}:legends.local`]: {
          BDEV1: { type: "m.room.encrypted", ciphertext: "second" },
        },
      },
    });
    expect(second.status).toBe(200);
    const afterSecond = (
      await db
        .select()
        .from(botToDeviceQueue)
        .where(sql`${botToDeviceQueue.botId} = ${botId}`)
    ).length;
    expect(afterSecond).toBe(afterFirst);
  });

  it("skips an unparseable matrix id without failing the whole request", async () => {
    const txnId = `t-skip-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const beforeBot = (
      await db
        .select()
        .from(botToDeviceQueue)
        .where(sql`${botToDeviceQueue.botId} = ${botId}`)
    ).length;
    const res = await send("m.room.encrypted", txnId, {
      messages: {
        "not-a-matrix-id": { BAD: { type: "m.room.encrypted" } },
        [`@bot.${botId}:legends.local`]: {
          BDEV1: { type: "m.room.encrypted", ciphertext: "ok" },
        },
      },
    });
    expect(res.status).toBe(200);
    const afterBot = (
      await db
        .select()
        .from(botToDeviceQueue)
        .where(sql`${botToDeviceQueue.botId} = ${botId}`)
    ).length;
    expect(afterBot).toBe(beforeBot + 1);
  });
});
