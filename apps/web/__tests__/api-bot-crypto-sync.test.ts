// GET /api/bot/v1/crypto/sync
//
// Task 11: bot-authenticated drain of bot_to_device_queue + per-algorithm
// unclaimed-OTK count, mirroring user-side /api/crypto/sync. The route
// long-polls up to `timeoutMs` (default 30s) but returns immediately once any
// envelopes are available. Drain happens via DELETE … RETURNING so envelopes
// are removed atomically with the read.
//
// We pass short timeouts here to keep the test fast — the second sync (no
// events) returns within the timeout window.
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GET } from "@/app/api/bot/v1/crypto/sync/route";
import { db } from "@/lib/db";
import {
  bots,
  botDevices,
  botOneTimeKeys,
  botToDeviceQueue,
} from "@legends/db/schema";

let token: string;
let botId: string;
let ownerId: string;
let senderBotId: string;

async function sync(timeoutMs = 100): Promise<Response> {
  return GET(
    new Request(`http://t/bot/v1/crypto/sync?timeout=${timeoutMs}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

describe("/api/bot/v1/crypto/sync", () => {
  beforeAll(async () => {
    ownerId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'sn') ON CONFLICT DO NOTHING`,
    );
    token = randomBytes(16).toString("hex");
    const [b] = await db
      .insert(bots)
      .values({
        name: `sn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: ownerId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
      })
      .returning({ id: bots.id });
    botId = b!.id;
    const [sb] = await db
      .insert(bots)
      .values({
        name: `sn-sender-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: ownerId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      })
      .returning({ id: bots.id });
    senderBotId = sb!.id;
    await db.insert(botDevices).values({
      botId,
      deviceId: "SDV",
      algorithms: ["a"],
      identityKeys: { "ed25519:SDV": "ed" },
    });
    await db.insert(botOneTimeKeys).values([
      {
        botId,
        deviceId: "SDV",
        keyId: "signed_curve25519:O1",
        algorithm: "signed_curve25519",
        keyJson: { key: "1" },
      },
      {
        botId,
        deviceId: "SDV",
        keyId: "signed_curve25519:O2",
        algorithm: "signed_curve25519",
        keyJson: { key: "2" },
      },
    ]);
  });

  it("first sync drains queue + reports unclaimed OTK count, second sync is empty", async () => {
    // Enqueue 3 envelopes: 2 user-sender, 1 bot-sender.
    await db.insert(botToDeviceQueue).values([
      {
        botId,
        deviceId: "SDV",
        eventType: "m.room.encrypted",
        senderUserId: ownerId,
        senderBotId: null,
        payload: { i: 0 },
      },
      {
        botId,
        deviceId: "SDV",
        eventType: "m.room.encrypted",
        senderUserId: ownerId,
        senderBotId: null,
        payload: { i: 1 },
      },
      {
        botId,
        deviceId: "SDV",
        eventType: "m.room.encrypted",
        senderUserId: null,
        senderBotId,
        payload: { i: 2 },
      },
    ]);

    const a = await sync();
    expect(a.status).toBe(200);
    const ja = await a.json();
    expect(ja.to_device.events).toHaveLength(3);
    expect(ja.device_one_time_keys_count.signed_curve25519).toBe(2);
    // Sender matrix-id should be a user namespace for the first two, bot for the third.
    const senders = ja.to_device.events.map((e: { sender: string }) => e.sender);
    expect(senders.filter((s: string) => s.startsWith("@bot."))).toHaveLength(1);
    expect(senders.filter((s: string) => s.startsWith("@") && !s.startsWith("@bot."))).toHaveLength(2);

    const b = await sync();
    expect(b.status).toBe(200);
    const jb = await b.json();
    expect(jb.to_device.events).toHaveLength(0);
  });

  it("missing bearer returns 401", async () => {
    const res = await GET(new Request("http://t/bot/v1/crypto/sync"));
    expect(res.status).toBe(401);
  });

  it("returns events that arrive mid-poll without waiting the full timeout", async () => {
    // Schedule an enqueue ~50ms in the future, then start a 2000ms poll.
    setTimeout(() => {
      void db
        .insert(botToDeviceQueue)
        .values({
          botId,
          deviceId: "SDV",
          eventType: "m.room.encrypted",
          senderUserId: ownerId,
          senderBotId: null,
          payload: { i: "late" },
        })
        .catch(() => {});
    }, 50);
    const t0 = Date.now();
    const res = await sync(2000);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.to_device.events.length).toBeGreaterThanOrEqual(1);
    // Should return shortly after the enqueue, well below the 2s ceiling.
    expect(elapsed).toBeLessThan(1500);
  });
});
