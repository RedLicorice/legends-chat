import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  bots,
  botDevices,
  botOneTimeKeys,
  botToDeviceQueue,
  botCryptoSentTxns,
} from "@legends/db/schema";
import { db } from "@/lib/db";
import { randomUUID, createHash } from "node:crypto";

describe("bot e2ee schema", () => {
  let botId: string;

  beforeAll(async () => {
    const ownerId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'owner-bot-e2ee-test') ON CONFLICT DO NOTHING`,
    );
    const [row] = await db
      .insert(bots)
      .values({
        name: `bot-e2ee-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: ownerId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      })
      .returning({
        id: bots.id,
        e2eeState: bots.e2eeState,
        e2eeDeviceId: bots.e2eeDeviceId,
      });
    botId = row!.id;
    expect(row!.e2eeState).toBe("disabled");
    expect(row!.e2eeDeviceId).toBeNull();
  });

  it("inserts bot_devices with identity keys", async () => {
    await db.insert(botDevices).values({
      botId,
      deviceId: "BOTDEV1",
      algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
      identityKeys: { "ed25519:BOTDEV1": "edpk", "curve25519:BOTDEV1": "cvpk" },
      signatures: { "@bot.x:legends.local": { "ed25519:BOTDEV1": "sig" } },
    });
    const got = await db
      .select()
      .from(botDevices)
      .where(sql`${botDevices.botId} = ${botId}`);
    expect(got).toHaveLength(1);
    expect(got[0]!.deviceId).toBe("BOTDEV1");
  });

  it("inserts a bot_one_time_keys row keyed by (bot, device, key_id)", async () => {
    await db.insert(botOneTimeKeys).values({
      botId,
      deviceId: "BOTDEV1",
      keyId: "signed_curve25519:AAAA",
      algorithm: "signed_curve25519",
      keyJson: { key: "k1" },
    });
    const got = await db
      .select()
      .from(botOneTimeKeys)
      .where(sql`${botOneTimeKeys.botId} = ${botId}`);
    expect(got).toHaveLength(1);
  });

  it("rejects bot_to_device_queue rows that set both sender_user_id and sender_bot_id", async () => {
    await expect(
      db.execute(sql`
        INSERT INTO bot_to_device_queue (bot_id, device_id, event_type, sender_user_id, sender_bot_id, payload)
        VALUES (${botId}, 'BOTDEV1', 'm.room.encrypted', ${randomUUID()}, ${randomUUID()}, '{}'::jsonb)
      `),
    ).rejects.toThrow();
  });

  it("dedups bot_crypto_sent_txns on (bot_id, txn_id)", async () => {
    await db.insert(botCryptoSentTxns).values({
      botId,
      txnId: "txn-1",
      eventType: "m.room.encrypted",
      bodyHash: Buffer.from("aa", "hex"),
    });
    await expect(
      db.insert(botCryptoSentTxns).values({
        botId,
        txnId: "txn-1",
        eventType: "m.room.encrypted",
        bodyHash: Buffer.from("bb", "hex"),
      }),
    ).rejects.toThrow();
  });
});
