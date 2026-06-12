// /api/crypto/keys/{query,claim} — strict Matrix CS shape for bot peers.
//
// Symptom (E2E #8): even with `ensureDmSession` calling
// updateTrackedUsers → pump → claim → shareRoomKey in the right order,
// the browser-side matrix-sdk-crypto-wasm panics deep inside
// `share_room_key`:
//
//   matrix-sdk-crypto-0.17.0/src/session_manager/group_sessions/mod.rs:218:54
//   "Session wasn't created nor shared"  →  RuntimeError: unreachable
//
// Hypothesis: the user-side wasm OlmMachine cannot track the bot's devices
// because the responses from `/api/crypto/keys/query` and
// `/api/crypto/keys/claim` for bot principals don't quite match the Matrix
// CS spec the wasm parses. If a device fails the wasm's self-validation
// (user_id parent ≠ device.user_id; or `keys` not keyed by `<algo>:<devid>`;
// or signatures not keyed by parent matrix id), the device is silently
// dropped, `getMissingSessions` returns no claim, no Olm 1:1 session is
// established, and `shareRoomKey` panics.
//
// These tests pin the response shape to the EXACT Matrix CS spec for bot
// peers so a future refactor that drops a field or renames it goes red.

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

const { POST: postQueryRoute } = await import("@/app/api/crypto/keys/query/route");
const { POST: postClaimRoute } = await import("@/app/api/crypto/keys/claim/route");
const { db } = await import("@/lib/db");
const { bots, botDevices, botOneTimeKeys } = await import("@legends/db/schema");

async function postQuery(body: unknown): Promise<Response> {
  return postQueryRoute(
    new Request("http://t/keys/query", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

async function postClaim(body: unknown): Promise<Response> {
  return postClaimRoute(
    new Request("http://t/keys/claim", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

// Device fixtures — exactly the post-fix-3 shape the bot SDK uploads via
// /api/bot/v1/crypto/keys/upload: `keys` and `signatures` both keyed by
// `<algorithm>:<deviceId>`, all inner ids are matrix-full-form bot ids.
const DEVICE_ID = "BMXSHAPE1";
const ED_KEY = "T2ursysMM5Qdc1siFzg45LNfvD1TS3z6kqDZCICDRBQ";
const CURVE_KEY = "+lsoCOUE/7egkPp8gYfeZs0YmYbZiMlZ1hLwvsC7ZS0";
const ED_SIG =
  "DfzeltYX+Bm58zw8Xrb4wcpo3M9kFYU9BJaAiznNfSfGUiCzOnOs8ZQ9dftOffDd7/SO9A28V1ph48zm6AMaCQ";
const OTK_KEY_ID = "signed_curve25519:AAAAMatrixShape";
const OTK_KEY = "cNcTXThb4t0Npc2RgMg8WNak4XNNadjrwLKthEN7sEY";
const OTK_SIG =
  "AutO50RPKtyE0P4PIQgpszU/fLTK6GCR3ybOxbkepxy3O7IFyUh4jJKnuaVkC45wAV1U7Cozj99BdgDOdqiPCA";

describe("/api/crypto/keys/query — bot peer Matrix CS shape", () => {
  let botId: string;
  let botMatrixId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    ownerUserId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${FAKE_USER_ID}, 'mxshape-tester'), (${ownerUserId}, 'mxshape-owner') ON CONFLICT DO NOTHING`,
    );

    const [b] = await db
      .insert(bots)
      .values({
        name: `mxshape-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      })
      .returning({ id: bots.id });
    botId = b!.id;
    botMatrixId = `@bot.${botId}:legends.local`;

    // Insert the bot device with Matrix-spec shape:
    //   keys keyed by "<algorithm>:<deviceId>"
    //   signatures keyed by full matrix bot id → "ed25519:<deviceId>"
    await db.insert(botDevices).values({
      botId,
      deviceId: DEVICE_ID,
      algorithms: [
        "m.olm.v1.curve25519-aes-sha2",
        "m.megolm.v1.aes-sha2",
      ],
      identityKeys: {
        [`ed25519:${DEVICE_ID}`]: ED_KEY,
        [`curve25519:${DEVICE_ID}`]: CURVE_KEY,
      },
      signatures: {
        [botMatrixId]: { [`ed25519:${DEVICE_ID}`]: ED_SIG },
      },
    });

    await db.insert(botOneTimeKeys).values({
      botId,
      deviceId: DEVICE_ID,
      keyId: OTK_KEY_ID,
      algorithm: "signed_curve25519",
      keyJson: {
        key: OTK_KEY,
        signatures: {
          [botMatrixId]: { [`ed25519:${DEVICE_ID}`]: OTK_SIG },
        },
      },
    });
  });

  it("response.device_keys parent key is the full bot matrix id (@bot.<uuid>:legends.local)", async () => {
    const res = await postQuery({
      device_keys: { [botMatrixId]: [] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_keys: Record<string, Record<string, unknown>>;
      failures: Record<string, unknown>;
    };
    // Wasm OlmMachine indexes device_keys by the EXACT matrix id it asked
    // for. A short id (just `<botId>`) is silently dropped — the bot's
    // devices never enter the tracked-users map.
    expect(Object.keys(body.device_keys)).toContain(botMatrixId);
    expect(body.failures).toEqual({});
  });

  it("each device entry carries Matrix CS-spec fields: user_id, device_id, algorithms, keys, signatures", async () => {
    const res = await postQuery({
      device_keys: { [botMatrixId]: [] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_keys: Record<
        string,
        Record<
          string,
          {
            user_id: string;
            device_id: string;
            algorithms: string[];
            keys: Record<string, string>;
            signatures: Record<string, Record<string, string>>;
          }
        >
      >;
    };
    const bucket = body.device_keys[botMatrixId];
    expect(bucket).toBeDefined();
    const dev = bucket![DEVICE_ID];
    expect(dev).toBeDefined();
    // user_id MUST match the parent matrix id — matrix-sdk-crypto drops the
    // device otherwise (silent rejection in keys_query response handling).
    expect(dev!.user_id).toBe(botMatrixId);
    expect(dev!.device_id).toBe(DEVICE_ID);
    expect(dev!.algorithms).toContain("m.olm.v1.curve25519-aes-sha2");
  });

  it("device.keys is keyed by `<algorithm>:<deviceId>` (NOT bare algorithm names)", async () => {
    const res = await postQuery({
      device_keys: { [botMatrixId]: [] },
    });
    const body = (await res.json()) as {
      device_keys: Record<
        string,
        Record<string, { keys: Record<string, string> }>
      >;
    };
    const dev = body.device_keys[botMatrixId]![DEVICE_ID]!;
    // Critical: matrix-sdk-crypto looks up `keys["ed25519:<device_id>"]` to
    // validate the self-signature. A bare `"ed25519"` key is rejected.
    expect(Object.keys(dev.keys)).toEqual(
      expect.arrayContaining([
        `ed25519:${DEVICE_ID}`,
        `curve25519:${DEVICE_ID}`,
      ]),
    );
    expect(dev.keys[`ed25519:${DEVICE_ID}`]).toBe(ED_KEY);
    expect(dev.keys[`curve25519:${DEVICE_ID}`]).toBe(CURVE_KEY);
    // Defensive: no bare-algorithm legacy entries.
    expect(dev.keys).not.toHaveProperty("ed25519");
    expect(dev.keys).not.toHaveProperty("curve25519");
  });

  it("device.signatures is keyed by the full bot matrix id → `ed25519:<deviceId>`", async () => {
    const res = await postQuery({
      device_keys: { [botMatrixId]: [] },
    });
    const body = (await res.json()) as {
      device_keys: Record<
        string,
        Record<string, { signatures: Record<string, Record<string, string>> }>
      >;
    };
    const dev = body.device_keys[botMatrixId]![DEVICE_ID]!;
    // The signature parent key MUST be the bot's full matrix id.
    // matrix-sdk-crypto verifies sig against `signatures[user_id][ed25519:<devid>]`.
    expect(Object.keys(dev.signatures)).toContain(botMatrixId);
    expect(dev.signatures[botMatrixId]).toBeDefined();
    expect(dev.signatures[botMatrixId]![`ed25519:${DEVICE_ID}`]).toBe(ED_SIG);
  });
});

describe("/api/crypto/keys/claim — bot peer Matrix CS shape", () => {
  let botId: string;
  let botMatrixId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    ownerUserId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${ownerUserId}, 'mxshape-claim-owner') ON CONFLICT DO NOTHING`,
    );

    const [b] = await db
      .insert(bots)
      .values({
        name: `mxshape-claim-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      })
      .returning({ id: bots.id });
    botId = b!.id;
    botMatrixId = `@bot.${botId}:legends.local`;

    await db.insert(botDevices).values({
      botId,
      deviceId: DEVICE_ID,
      algorithms: [
        "m.olm.v1.curve25519-aes-sha2",
        "m.megolm.v1.aes-sha2",
      ],
      identityKeys: {
        [`ed25519:${DEVICE_ID}`]: ED_KEY,
        [`curve25519:${DEVICE_ID}`]: CURVE_KEY,
      },
      signatures: {
        [botMatrixId]: { [`ed25519:${DEVICE_ID}`]: ED_SIG },
      },
    });

    // Seed three OTKs — each `it` claim consumes one (FOR UPDATE SKIP LOCKED).
    // Using distinct keyIds so the tests can pick one to assert against.
    for (let i = 0; i < 3; i++) {
      await db.insert(botOneTimeKeys).values({
        botId,
        deviceId: DEVICE_ID,
        keyId: `${OTK_KEY_ID}${i}`,
        algorithm: "signed_curve25519",
        keyJson: {
          key: OTK_KEY,
          signatures: {
            [botMatrixId]: { [`ed25519:${DEVICE_ID}`]: OTK_SIG },
          },
        },
      });
    }
  });

  it("response.one_time_keys parent key is the full bot matrix id", async () => {
    const res = await postClaim({
      one_time_keys: {
        [botMatrixId]: { [DEVICE_ID]: "signed_curve25519" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      one_time_keys: Record<string, Record<string, Record<string, unknown>>>;
      failures: Record<string, unknown>;
    };
    expect(Object.keys(body.one_time_keys)).toContain(botMatrixId);
    expect(body.failures).toEqual({});
  });

  it("the OTK key id includes the algorithm prefix (`signed_curve25519:<keyid>`)", async () => {
    const res = await postClaim({
      one_time_keys: {
        [botMatrixId]: { [DEVICE_ID]: "signed_curve25519" },
      },
    });
    const body = (await res.json()) as {
      one_time_keys: Record<
        string,
        Record<string, Record<string, { key: string; signatures: Record<string, Record<string, string>> }>>
      >;
    };
    const deviceBucket = body.one_time_keys[botMatrixId]![DEVICE_ID];
    expect(deviceBucket).toBeDefined();
    // Matrix CS: response.one_time_keys[user][device] is keyed by
    // "<algo>:<keyId>". matrix-sdk-crypto rejects bare keyIds.
    const keyIds = Object.keys(deviceBucket!);
    expect(keyIds).toHaveLength(1);
    expect(keyIds[0]).toMatch(/^signed_curve25519:/);
    expect(keyIds[0]).toContain(OTK_KEY_ID);
  });

  it("the OTK value carries `key` and `signatures` keyed by the bot matrix id", async () => {
    const res = await postClaim({
      one_time_keys: {
        [botMatrixId]: { [DEVICE_ID]: "signed_curve25519" },
      },
    });
    const body = (await res.json()) as {
      one_time_keys: Record<
        string,
        Record<string, Record<string, { key: string; signatures: Record<string, Record<string, string>> }>>
      >;
    };
    const deviceBucket = body.one_time_keys[botMatrixId]![DEVICE_ID]!;
    const [keyId] = Object.keys(deviceBucket);
    expect(keyId).toBeDefined();
    const entry = deviceBucket[keyId!]!;
    expect(entry.key).toBe(OTK_KEY);
    // signatures parent key MUST be the bot's full matrix id.
    expect(Object.keys(entry.signatures)).toContain(botMatrixId);
    expect(entry.signatures[botMatrixId]![`ed25519:${DEVICE_ID}`]).toBe(OTK_SIG);
  });
});
