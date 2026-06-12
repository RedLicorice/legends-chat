// /api/crypto/keys/query — user + bot dispatch.
//
// Task 5: the route currently uses fromMatrixUserId only, so any bot-namespace
// id (@bot.<uuid>:legends.local) lands in `failures` instead of dispatching
// to bot_devices. This test asserts the new behavior: bot-id batches return
// bot_devices rows, user-id batches keep returning userKeyBundles rows.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

const FAKE_USER_ID = randomUUID();

vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({
    id: FAKE_USER_ID,
    role: "user",
    permissions: new Set<string>(),
    displayName: "tester",
    avatarUrl: null,
    isAnon: false,
    presenceOptOut: false,
  }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkAndIncrement: async () => ({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  }),
}));

const { POST } = await import("@/app/api/crypto/keys/query/route");
const { db } = await import("@/lib/db");
const { bots, botDevices, userKeyBundles } = await import("@legends/db/schema");

async function postQuery(body: unknown): Promise<Response> {
  return POST(
    new Request("http://t/keys/query", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

describe("/api/crypto/keys/query — user + bot dispatch", () => {
  let peerUserId: string;
  let botId: string;

  beforeAll(async () => {
    peerUserId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${FAKE_USER_ID}, 'kq-tester'), (${peerUserId}, 'kq-peer') ON CONFLICT DO NOTHING`,
    );

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

    const [b] = await db
      .insert(bots)
      .values({
        name: `kq-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: peerUserId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      })
      .returning({ id: bots.id });
    botId = b!.id;

    await db.insert(botDevices).values({
      botId,
      deviceId: "BDEV1",
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
      identityKeys: { "ed25519:BDEV1": "edpk-b" },
      signatures: {
        [`@bot.${botId}:legends.local`]: { "ed25519:BDEV1": "sig" },
      },
    });
  });

  it("returns user device for user-only batch", async () => {
    const res = await postQuery({
      device_keys: { [`@${peerUserId}:legends.local`]: [] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_keys: Record<string, Record<string, { device_id: string; algorithms: string[] }>>;
      failures: Record<string, unknown>;
    };
    const userBucket = body.device_keys[`@${peerUserId}:legends.local`];
    expect(userBucket).toBeDefined();
    expect(Object.keys(userBucket!)).toContain("PDEV1");
    expect(userBucket!["PDEV1"]!.algorithms).toContain(
      "m.olm.v1.curve25519-aes-sha2",
    );
    expect(body.failures).toEqual({});
  });

  it("returns bot device for bot-only batch", async () => {
    const res = await postQuery({
      device_keys: { [`@bot.${botId}:legends.local`]: [] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_keys: Record<string, Record<string, { device_id: string; user_id: string }>>;
      failures: Record<string, unknown>;
    };
    const botBucket = body.device_keys[`@bot.${botId}:legends.local`];
    expect(botBucket).toBeDefined();
    expect(Object.keys(botBucket!)).toContain("BDEV1");
    expect(botBucket!["BDEV1"]!.user_id).toBe(`@bot.${botId}:legends.local`);
    expect(body.failures).toEqual({});
  });

  it("returns both for mixed batch and applies the device filter", async () => {
    const res = await postQuery({
      device_keys: {
        [`@${peerUserId}:legends.local`]: ["PDEV1"],
        [`@bot.${botId}:legends.local`]: ["BDEV1"],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_keys: Record<string, Record<string, unknown>>;
    };
    expect(body.device_keys[`@${peerUserId}:legends.local`]).toBeDefined();
    expect(body.device_keys[`@bot.${botId}:legends.local`]).toBeDefined();
    expect(
      Object.keys(body.device_keys[`@${peerUserId}:legends.local`]!),
    ).toEqual(["PDEV1"]);
    expect(
      Object.keys(body.device_keys[`@bot.${botId}:legends.local`]!),
    ).toEqual(["BDEV1"]);
  });

  it("reports an invalid matrix-id batch entry in failures (other entries still succeed)", async () => {
    const res = await postQuery({
      device_keys: {
        [`@${peerUserId}:legends.local`]: [],
        "not-a-matrix-id": [],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_keys: Record<string, unknown>;
      failures: Record<string, { errcode: string }>;
    };
    expect(body.failures["not-a-matrix-id"]).toBeDefined();
    expect(body.failures["not-a-matrix-id"]!.errcode).toBe("M_UNKNOWN");
    expect(body.device_keys[`@${peerUserId}:legends.local`]).toBeDefined();
  });
});
