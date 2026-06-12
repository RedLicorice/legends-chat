import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import {
  parsePrincipalFromMatrixId,
  getDeviceList,
  claimOneTimeKey,
  enqueueToDevice,
  idempotencyCheck,
} from "@/lib/crypto-principal";
import { db } from "@/lib/db";
import {
  bots,
  botDevices,
  botOneTimeKeys,
  botToDeviceQueue,
  userKeyBundles,
  userOneTimePrekeys,
  userToDeviceQueue,
} from "@legends/db/schema";

describe("crypto-principal dispatch", () => {
  let userId: string;
  let botId: string;
  let ownerId: string;

  beforeAll(async () => {
    userId = randomUUID();
    ownerId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${userId}, 'cp-test-user'), (${ownerId}, 'cp-test-owner') ON CONFLICT DO NOTHING`,
    );

    const [b] = await db
      .insert(bots)
      .values({
        name: `cp-test-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: ownerId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      })
      .returning({ id: bots.id });
    botId = b!.id;

    // Seed user device + OTK.
    await db.insert(userKeyBundles).values({
      userId,
      deviceId: "UDEV1",
      identityPublicKey: "edpk-u",
      algorithmsJson: ["m.olm.v1.curve25519-aes-sha2"],
      keysJson: { "ed25519:UDEV1": "edpk-u", "curve25519:UDEV1": "cvpk-u" },
      signaturesJson: { [`@${userId}:legends.local`]: { "ed25519:UDEV1": "sig" } },
    });
    await db.insert(userOneTimePrekeys).values({
      userId,
      deviceId: "UDEV1",
      keyId: "signed_curve25519:UOTK1",
      algorithm: "signed_curve25519",
      keyJson: { key: "u-otk" },
    });

    // Seed bot device + OTK.
    await db.insert(botDevices).values({
      botId,
      deviceId: "BDEV1",
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
      identityKeys: { "ed25519:BDEV1": "edpk-b" },
      signatures: { [`@bot.${botId}:legends.local`]: { "ed25519:BDEV1": "sig" } },
    });
    await db.insert(botOneTimeKeys).values({
      botId,
      deviceId: "BDEV1",
      keyId: "signed_curve25519:BOTK1",
      algorithm: "signed_curve25519",
      keyJson: { key: "b-otk" },
    });
  });

  it("parsePrincipalFromMatrixId disambiguates", () => {
    expect(parsePrincipalFromMatrixId(`@${userId}:legends.local`)).toEqual({
      type: "user",
      id: userId,
    });
    expect(parsePrincipalFromMatrixId(`@bot.${botId}:legends.local`)).toEqual({
      type: "bot",
      id: botId,
    });
    expect(parsePrincipalFromMatrixId("nope")).toBeNull();
  });

  it("getDeviceList returns user device for user principal", async () => {
    const list = await getDeviceList({ type: "user", id: userId });
    expect(list.devices.map((d) => d.deviceId)).toContain("UDEV1");
    const dev = list.devices.find((d) => d.deviceId === "UDEV1")!;
    expect(dev.algorithms).toContain("m.olm.v1.curve25519-aes-sha2");
    expect(dev.keys["ed25519:UDEV1"]).toBe("edpk-u");
  });

  it("getDeviceList returns bot device for bot principal", async () => {
    const list = await getDeviceList({ type: "bot", id: botId });
    expect(list.devices.map((d) => d.deviceId)).toContain("BDEV1");
    const dev = list.devices.find((d) => d.deviceId === "BDEV1")!;
    expect(dev.algorithms).toContain("m.olm.v1.curve25519-aes-sha2");
    expect(dev.keys["ed25519:BDEV1"]).toBe("edpk-b");
  });

  it("claimOneTimeKey atomically marks a user OTK claimed", async () => {
    const otk = await claimOneTimeKey(
      { type: "user", id: userId },
      "UDEV1",
      "signed_curve25519",
    );
    expect(otk).not.toBeNull();
    expect(otk!.keyId).toBe("signed_curve25519:UOTK1");
    const again = await claimOneTimeKey(
      { type: "user", id: userId },
      "UDEV1",
      "signed_curve25519",
    );
    expect(again).toBeNull();
  });

  it("claimOneTimeKey atomically marks a bot OTK claimed", async () => {
    const otk = await claimOneTimeKey(
      { type: "bot", id: botId },
      "BDEV1",
      "signed_curve25519",
    );
    expect(otk).not.toBeNull();
    expect(otk!.keyId).toBe("signed_curve25519:BOTK1");
    const again = await claimOneTimeKey(
      { type: "bot", id: botId },
      "BDEV1",
      "signed_curve25519",
    );
    expect(again).toBeNull();
  });

  it("enqueueToDevice routes to bot queue for bot recipient (user sender)", async () => {
    await enqueueToDevice({
      recipient: { type: "bot", id: botId },
      recipientDeviceId: "BDEV1",
      eventType: "m.room.encrypted",
      payload: { hello: "bot" },
      sender: { type: "user", id: userId },
    });
    const rows = await db
      .select()
      .from(botToDeviceQueue)
      .where(sql`${botToDeviceQueue.botId} = ${botId}`);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((r) => r.senderUserId === userId)!;
    expect(row).toBeDefined();
    expect(row.senderUserId).toBe(userId);
    expect(row.senderBotId).toBeNull();
    expect(row.deviceId).toBe("BDEV1");
    expect(row.eventType).toBe("m.room.encrypted");
  });

  it("enqueueToDevice routes to bot queue for bot recipient (bot sender)", async () => {
    const otherBotId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${otherBotId}, 'cp-test-other-owner') ON CONFLICT DO NOTHING`,
    );
    const [other] = await db
      .insert(bots)
      .values({
        name: `cp-test-other-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: otherBotId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      })
      .returning({ id: bots.id });
    await enqueueToDevice({
      recipient: { type: "bot", id: botId },
      recipientDeviceId: "BDEV1",
      eventType: "m.room.encrypted",
      payload: { hello: "from-bot" },
      sender: { type: "bot", id: other!.id },
    });
    const rows = await db
      .select()
      .from(botToDeviceQueue)
      .where(sql`${botToDeviceQueue.botId} = ${botId}`);
    const row = rows.find((r) => r.senderBotId === other!.id)!;
    expect(row).toBeDefined();
    expect(row.senderBotId).toBe(other!.id);
    expect(row.senderUserId).toBeNull();
  });

  it("enqueueToDevice routes to user queue for user recipient (user sender)", async () => {
    await enqueueToDevice({
      recipient: { type: "user", id: userId },
      recipientDeviceId: "UDEV1",
      eventType: "m.room.encrypted",
      payload: { hello: "user-from-user" },
      sender: { type: "user", id: ownerId },
      senderDeviceId: "OWNERDEV",
    });
    const rows = await db
      .select()
      .from(userToDeviceQueue)
      .where(
        sql`${userToDeviceQueue.recipientUserId} = ${userId} AND ${userToDeviceQueue.senderUserId} = ${ownerId}`,
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("enqueueToDevice routes bot→user envelope with bot-owner sender_user_id + bot:<id> sender_device_id", async () => {
    // bot→user envelope path: user_to_device_queue.sender_user_id is NOT NULL
    // today, so we synthesize sender_user_id = bot owner, sender_device_id =
    // `bot:<botId>` to keep the schema valid. Migration 0046 will widen the
    // table; until then this is the bridge the dispatch helper uses.
    await enqueueToDevice({
      recipient: { type: "user", id: userId },
      recipientDeviceId: "UDEV1",
      eventType: "m.room.encrypted",
      payload: { hello: "user-from-bot" },
      sender: { type: "bot", id: botId },
    });
    const rows = await db
      .select()
      .from(userToDeviceQueue)
      .where(
        sql`${userToDeviceQueue.recipientUserId} = ${userId} AND ${userToDeviceQueue.senderDeviceId} = ${`bot:${botId}`}`,
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    // Per R3/follow-up workaround: bot's owner stands in as sender_user_id.
    expect(row.senderUserId).toBe(ownerId);
    expect(row.senderDeviceId).toBe(`bot:${botId}`);
  });

  it("idempotencyCheck (bot sender): stores, then dedups, then reports conflict on body mismatch", async () => {
    const txnId = `txn-ic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const a = await idempotencyCheck(
      { type: "bot", id: botId },
      txnId,
      "m.room.encrypted",
      Buffer.from("aa", "hex"),
    );
    expect(a).toEqual({ stored: true, conflict: false });
    const b = await idempotencyCheck(
      { type: "bot", id: botId },
      txnId,
      "m.room.encrypted",
      Buffer.from("aa", "hex"),
    );
    expect(b).toEqual({ stored: false, conflict: false });
    const c = await idempotencyCheck(
      { type: "bot", id: botId },
      txnId,
      "m.room.encrypted",
      Buffer.from("bb", "hex"),
    );
    expect(c).toEqual({ stored: false, conflict: true });
  });

  it("idempotencyCheck (user sender): stores then dedups (conflict always false; legacy table has no body hash)", async () => {
    const txnId = `txn-ic-u-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const a = await idempotencyCheck(
      { type: "user", id: userId },
      txnId,
      "m.room.encrypted",
      Buffer.from("aa", "hex"),
    );
    expect(a).toEqual({ stored: true, conflict: false });
    const b = await idempotencyCheck(
      { type: "user", id: userId },
      txnId,
      "m.room.encrypted",
      Buffer.from("bb", "hex"),
    );
    expect(b).toEqual({ stored: false, conflict: false });
  });
});
