import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { POST } from "@/app/api/bot/v1/crypto/keys/upload/route";
import { db } from "@/lib/db";
import { bots, botDevices, botOneTimeKeys } from "@legends/db/schema";

let botId: string;
let token: string;

async function withAuth(body: unknown): Promise<Response> {
  return POST(new Request("http://t/bot/v1/crypto/keys/upload", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

const SAMPLE = (deviceId: string, ed: string) => ({
  device_keys: {
    device_id: deviceId,
    identity_keys: { [`ed25519:${deviceId}`]: ed, [`curve25519:${deviceId}`]: "cv" },
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
    }).returning({ id: bots.id });
    botId = b!.id;
  });

  it("first upload transitions bots.e2ee_state to ready + sets device_id", async () => {
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
});
