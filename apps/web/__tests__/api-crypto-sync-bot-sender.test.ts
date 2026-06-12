// GET /api/crypto/sync — bot-origin sender id translation.
//
// Bug: when a bot uses /api/crypto/sendToDevice to ship an m.room.encrypted
// envelope (or m.room_key) to a user, the queue row carries
// sender_user_id = bots.owner_user_id and sender_device_id = "bot:<botId>"
// because user_to_device_queue.sender_user_id is NOT NULL (R1 deferred-
// migration plan). The sync route used to emit
// `sender: toMatrixUserId(row.sender_user_id)`, surfacing the owner's id —
// matrix-sdk-crypto then sees the inner Olm sender_key (the bot's curve25519)
// disagree with the envelope `sender` and silently drops the m.room_key, so
// bot replies render as "Locked".
//
// Fix: when sender_device_id matches the `bot:<uuid>` workaround pattern,
// emit `@bot.<botId>:legends.local` instead.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

let CALLER_USER_ID = randomUUID();

vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({
    id: CALLER_USER_ID,
    role: "user",
    permissions: new Set<string>(),
    displayName: "sync-tester",
    avatarUrl: null,
    isAnon: false,
    presenceOptOut: false,
  }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkAndIncrement: async () => ({
    allowed: true,
    remaining: 239,
    resetAt: Date.now() + 60_000,
  }),
}));

const { GET } = await import("@/app/api/crypto/sync/route");
const { db } = await import("@/lib/db");
const { bots, userKeyBundles, userToDeviceQueue } = await import(
  "@legends/db/schema"
);

const DEVICE_ID = "USRDEVSYNC";

async function getSync(): Promise<Response> {
  return GET(
    new Request(`http://t/api/crypto/sync?device_id=${DEVICE_ID}`) as never,
  );
}

describe("/api/crypto/sync — bot-origin sender translation", () => {
  let botId: string;
  let ownerUserId: string;
  let peerUserId: string;

  beforeAll(async () => {
    ownerUserId = randomUUID();
    peerUserId = randomUUID();
    CALLER_USER_ID = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name)
          VALUES (${CALLER_USER_ID}, 'sync-caller'),
                 (${ownerUserId}, 'sync-owner'),
                 (${peerUserId}, 'sync-peer')
          ON CONFLICT DO NOTHING`,
    );
    const [b] = await db
      .insert(bots)
      .values({
        name: `sync-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      })
      .returning({ id: bots.id });
    botId = b!.id;

    // The caller needs a user_key_bundles row so the OTK/fallback lookups
    // don't error — content of the bundle doesn't matter for this test.
    await db.insert(userKeyBundles).values({
      userId: CALLER_USER_ID,
      deviceId: DEVICE_ID,
      identityPublicKey: "edpk-caller",
      algorithmsJson: ["m.olm.v1.curve25519-aes-sha2"],
      keysJson: { [`ed25519:${DEVICE_ID}`]: "edpk-caller" },
      signaturesJson: {
        [`@${CALLER_USER_ID}:legends.local`]: {
          [`ed25519:${DEVICE_ID}`]: "sig",
        },
      },
    });
  });

  it("translates a bot-origin queue row (sender_device_id='bot:<uuid>') to @bot.<id>:legends.local", async () => {
    // Enqueue a row shaped like the sendToDevice bot-sender workaround:
    // sender_user_id = bots.owner_user_id, sender_device_id = "bot:<botId>".
    await db.insert(userToDeviceQueue).values({
      recipientUserId: CALLER_USER_ID,
      recipientDeviceId: DEVICE_ID,
      senderUserId: ownerUserId,
      senderDeviceId: `bot:${botId}`,
      eventType: "m.room.encrypted",
      contentJson: { ciphertext: "bot-origin" },
      txnId: `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });

    const res = await getSync();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      to_device: {
        events: { type: string; sender: string; content: Record<string, unknown> }[];
      };
    };
    const ev = json.to_device.events.find(
      (e) => (e.content as { ciphertext?: string }).ciphertext === "bot-origin",
    );
    expect(ev).toBeDefined();
    expect(ev!.sender).toBe(`@bot.${botId}:legends.local`);
    // Must NOT leak the bot's owner user id as the sender.
    expect(ev!.sender).not.toBe(`@${ownerUserId}:legends.local`);
  });

  it("preserves the user-origin sender id for non-bot rows", async () => {
    await db.insert(userToDeviceQueue).values({
      recipientUserId: CALLER_USER_ID,
      recipientDeviceId: DEVICE_ID,
      senderUserId: peerUserId,
      senderDeviceId: "PEERDEV1",
      eventType: "m.room.encrypted",
      contentJson: { ciphertext: "user-origin" },
      txnId: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });

    const res = await getSync();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      to_device: {
        events: { type: string; sender: string; content: Record<string, unknown> }[];
      };
    };
    const ev = json.to_device.events.find(
      (e) => (e.content as { ciphertext?: string }).ciphertext === "user-origin",
    );
    expect(ev).toBeDefined();
    expect(ev!.sender).toBe(`@${peerUserId}:legends.local`);
    expect(ev!.sender).not.toMatch(/^@bot\./);
  });
});
