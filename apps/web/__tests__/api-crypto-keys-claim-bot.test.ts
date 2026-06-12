// /api/crypto/keys/claim — user + bot dispatch.
//
// Bug: the route was using `fromMatrixUserId` for every batch entry, so a
// bot-namespace id (@bot.<uuid>:legends.local) couldn't parse and landed in
// `failures` with "invalid matrix user id" — blocking every user→bot E2EE
// handshake. This test asserts the fixed behavior: bot ids dispatch through
// `claimOneTimeKey({type:"bot", ...})` and return the bot OTK, while user ids
// continue to claim from `user_one_time_prekeys` unchanged.
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

const { POST } = await import("@/app/api/crypto/keys/claim/route");
const { db } = await import("@/lib/db");
const { bots, botDevices, botOneTimeKeys, userKeyBundles, userOneTimePrekeys } =
  await import("@legends/db/schema");

async function postClaim(body: unknown): Promise<Response> {
  return POST(
    new Request("http://t/keys/claim", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

describe("/api/crypto/keys/claim — user + bot dispatch", () => {
  let peerUserId: string;
  let peerBotId: string;

  beforeAll(async () => {
    peerUserId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${FAKE_USER_ID}, 'kc-tester'), (${peerUserId}, 'kc-peer') ON CONFLICT DO NOTHING`,
    );

    // Seed a user device + OTK so the user-side path still has something to
    // claim (no-regression check).
    await db.insert(userKeyBundles).values({
      userId: peerUserId,
      deviceId: "UCDEV1",
      identityPublicKey: "edpk-u",
      algorithmsJson: ["m.olm.v1.curve25519-aes-sha2"],
      keysJson: { "ed25519:UCDEV1": "edpk-u" },
      signaturesJson: {
        [`@${peerUserId}:legends.local`]: { "ed25519:UCDEV1": "sig" },
      },
    });
    await db.insert(userOneTimePrekeys).values({
      userId: peerUserId,
      deviceId: "UCDEV1",
      keyId: "signed_curve25519:UCOTK1",
      algorithm: "signed_curve25519",
      keyJson: { key: "u-otk" },
    });

    // Seed a bot + device + OTK (the bug-reproducing path).
    const [b] = await db
      .insert(bots)
      .values({
        name: `kc-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: peerUserId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      })
      .returning({ id: bots.id });
    peerBotId = b!.id;

    await db.insert(botDevices).values({
      botId: peerBotId,
      deviceId: "BCDEV1",
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
      identityKeys: { "ed25519:BCDEV1": "edpk-b" },
      signatures: {
        [`@bot.${peerBotId}:legends.local`]: { "ed25519:BCDEV1": "sig" },
      },
    });
    await db.insert(botOneTimeKeys).values({
      botId: peerBotId,
      deviceId: "BCDEV1",
      keyId: "signed_curve25519:BCOTK1",
      algorithm: "signed_curve25519",
      keyJson: { key: "b-otk" },
    });
  });

  it("claims a bot OTK and echoes the bot matrix id in the response", async () => {
    const res = await postClaim({
      one_time_keys: {
        [`@bot.${peerBotId}:legends.local`]: { BCDEV1: "signed_curve25519" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      one_time_keys: Record<string, Record<string, Record<string, unknown>>>;
      failures: Record<string, unknown>;
    };
    const bucket = body.one_time_keys[`@bot.${peerBotId}:legends.local`];
    expect(bucket).toBeDefined();
    expect(Object.keys(bucket!.BCDEV1!)).toContain("signed_curve25519:BCOTK1");
    expect(body.failures).toEqual({});
  });

  it("still claims a user OTK (no regression)", async () => {
    const res = await postClaim({
      one_time_keys: {
        [`@${peerUserId}:legends.local`]: { UCDEV1: "signed_curve25519" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      one_time_keys: Record<string, Record<string, Record<string, unknown>>>;
      failures: Record<string, unknown>;
    };
    const bucket = body.one_time_keys[`@${peerUserId}:legends.local`];
    expect(bucket).toBeDefined();
    expect(Object.keys(bucket!.UCDEV1!)).toContain("signed_curve25519:UCOTK1");
    expect(body.failures).toEqual({});
  });

  it("reports unparseable matrix ids in failures with the new 'invalid matrix id' wording", async () => {
    const res = await postClaim({
      one_time_keys: {
        "not-a-matrix-id": { DEV: "signed_curve25519" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      one_time_keys: Record<string, unknown>;
      failures: Record<string, { errcode: string; error: string }>;
    };
    expect(body.failures["not-a-matrix-id"]).toBeDefined();
    expect(body.failures["not-a-matrix-id"]!.errcode).toBe("M_UNKNOWN");
    expect(body.failures["not-a-matrix-id"]!.error).toBe("invalid matrix id");
  });
});
