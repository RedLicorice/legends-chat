import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { POST } from "@/app/api/bot/v1/crypto/keys/upload/route";
import { db } from "@/lib/db";
import { bots, botDevices, botOneTimeKeys } from "@legends/db/schema";

let botId: string;
let token: string;

async function withAuth(body: unknown, t = token): Promise<Response> {
  return POST(new Request("http://t/bot/v1/crypto/keys/upload", {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

// Matches matrix-sdk-crypto-wasm's `keys_upload` OutgoingRequest body, which
// in turn mirrors the Matrix CS API: device_keys.keys is `{<algo:devid>: b64}`
// (NOT `identity_keys`), `algorithms` and `signatures` sit alongside.
const SAMPLE = (deviceId: string, ed: string) => ({
  device_keys: {
    user_id: `@bot.${botId}:legends.local`,
    device_id: deviceId,
    keys: { [`ed25519:${deviceId}`]: ed, [`curve25519:${deviceId}`]: "cv" },
    algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    signatures: { ["selfsig"]: { [`ed25519:${deviceId}`]: "sig" } },
  },
  one_time_keys: {
    "signed_curve25519:AAAA": { key: "k1" },
    "signed_curve25519:BBBB": { key: "k2" },
  },
});

describe("/api/bot/v1/crypto/keys/upload", () => {
  beforeAll(async () => {
    const ownerId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'kup') ON CONFLICT DO NOTHING`);
    token = randomBytes(16).toString("hex");
    const [b] = await db.insert(bots).values({
      name: `kup-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      e2eeState: "pending",
    }).returning({ id: bots.id });
    botId = b!.id;
  });

  it("first upload (device_keys+OTKs) transitions e2ee_state pending → ready", async () => {
    const res = await withAuth(SAMPLE("BDEV1", "edpk1"));
    expect(res.status).toBe(200);
    const [bot] = await db.select().from(bots).where(sql`${bots.id} = ${botId}`);
    expect(bot!.e2eeState).toBe("ready");
    expect(bot!.e2eeDeviceId).toBe("BDEV1");
    const devs = await db.select().from(botDevices).where(sql`${botDevices.botId} = ${botId}`);
    expect(devs).toHaveLength(1);
    const otks = await db.select().from(botOneTimeKeys).where(sql`${botOneTimeKeys.botId} = ${botId}`);
    expect(otks).toHaveLength(2);
  });

  it("re-upload with same device + identity is idempotent (200, no extra rows)", async () => {
    const before = (await db.select().from(botDevices).where(sql`${botDevices.botId} = ${botId}`)).length;
    const res = await withAuth(SAMPLE("BDEV1", "edpk1"));
    expect(res.status).toBe(200);
    const after = (await db.select().from(botDevices).where(sql`${botDevices.botId} = ${botId}`)).length;
    expect(after).toBe(before);
  });

  it("rejects identity mismatch on same device with 422", async () => {
    const res = await withAuth(SAMPLE("BDEV1", "edpk-different"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errcode).toBe("crypto_keys_invalid");
  });

  it("OTK-only top-up (no device_keys) accepts and appends OTKs", async () => {
    const before = (await db.select().from(botOneTimeKeys).where(sql`${botOneTimeKeys.botId} = ${botId}`)).length;
    const res = await withAuth({
      one_time_keys: {
        "signed_curve25519:CCCC": { key: "k3" },
        "signed_curve25519:DDDD": { key: "k4" },
      },
    });
    expect(res.status).toBe(200);
    const after = (await db.select().from(botOneTimeKeys).where(sql`${botOneTimeKeys.botId} = ${botId}`)).length;
    expect(after).toBe(before + 2);
    const body = await res.json();
    expect(body.one_time_key_counts.signed_curve25519).toBeGreaterThanOrEqual(4);
  });

  it("OTK-only top-up before device_keys upload is 422 (no device on file)", async () => {
    // Fresh bot that has never uploaded device_keys.
    const ownerId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'kup2') ON CONFLICT DO NOTHING`);
    const otkToken = randomBytes(16).toString("hex");
    await db.insert(bots).values({
      name: `kup-otk-${Date.now()}`,
      ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(otkToken).digest("hex"),
      e2eeState: "pending",
    });
    const res = await withAuth(
      {
        one_time_keys: { "signed_curve25519:AA": { key: "k" } },
      },
      otkToken,
    );
    expect(res.status).toBe(422);
  });

  it("OTK-only top-up does not regress e2ee_state from ready", async () => {
    const res = await withAuth({
      one_time_keys: { "signed_curve25519:EEEE": { key: "k5" } },
    });
    expect(res.status).toBe(200);
    const [bot] = await db.select().from(bots).where(sql`${bots.id} = ${botId}`);
    expect(bot!.e2eeState).toBe("ready");
    expect(bot!.e2eeDeviceId).toBe("BDEV1");
  });

  it("empty body (no device_keys and no one_time_keys) is 422", async () => {
    const res = await withAuth({});
    expect(res.status).toBe(422);
  });
});
