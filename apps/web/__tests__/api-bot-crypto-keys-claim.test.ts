import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { POST } from "@/app/api/bot/v1/crypto/keys/claim/route";
import { db } from "@/lib/db";
import { bots, botDevices, botOneTimeKeys, userKeyBundles, userOneTimePrekeys } from "@legends/db/schema";

let token: string;
let peerUserId: string;
let peerBotId: string;

async function postClaim(body: unknown): Promise<Response> {
  return POST(new Request("http://t/bot/v1/crypto/keys/claim", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("/api/bot/v1/crypto/keys/claim", () => {
  beforeAll(async () => {
    const ownerId = randomUUID();
    peerUserId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'cl'), (${peerUserId}, 'cl-peer') ON CONFLICT DO NOTHING`);
    await db.insert(userKeyBundles).values({
      userId: peerUserId, deviceId: "UCL", identityPublicKey: "ed",
      algorithmsJson: ["a"], keysJson: { "ed25519:UCL": "ed" },
      signaturesJson: { [`@${peerUserId}:legends.local`]: { "ed25519:UCL": "s" } },
    });
    await db.insert(userOneTimePrekeys).values({
      userId: peerUserId, deviceId: "UCL", keyId: "signed_curve25519:UO1",
      algorithm: "signed_curve25519", keyJson: { key: "u1" },
    });
    token = randomBytes(16).toString("hex");
    await db.insert(bots).values({
      name: `cl-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    const [b2] = await db.insert(bots).values({
      name: `cl-peer-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    }).returning({ id: bots.id });
    peerBotId = b2!.id;
    await db.insert(botDevices).values({
      botId: peerBotId, deviceId: "BCL",
      algorithms: ["a"], identityKeys: { "ed25519:BCL": "ed" },
    });
    await db.insert(botOneTimeKeys).values({
      botId: peerBotId, deviceId: "BCL", keyId: "signed_curve25519:BO1",
      algorithm: "signed_curve25519", keyJson: { key: "b1" },
    });
  });

  it("claims a user OTK", async () => {
    const res = await postClaim({
      one_time_keys: { [`@${peerUserId}:legends.local`]: { UCL: "signed_curve25519" } },
    });
    const body = await res.json();
    const k = body.one_time_keys[`@${peerUserId}:legends.local`].UCL;
    expect(Object.keys(k)).toContain("signed_curve25519:UO1");
  });

  it("claims a bot OTK", async () => {
    const res = await postClaim({
      one_time_keys: { [`@bot.${peerBotId}:legends.local`]: { BCL: "signed_curve25519" } },
    });
    const body = await res.json();
    const k = body.one_time_keys[`@bot.${peerBotId}:legends.local`].BCL;
    expect(Object.keys(k)).toContain("signed_curve25519:BO1");
  });

  it("exhausted pool: device omitted from response", async () => {
    const res = await postClaim({
      one_time_keys: { [`@${peerUserId}:legends.local`]: { UCL: "signed_curve25519" } },
    });
    const body = await res.json();
    expect(body.one_time_keys[`@${peerUserId}:legends.local`]?.UCL).toBeUndefined();
  });
});
