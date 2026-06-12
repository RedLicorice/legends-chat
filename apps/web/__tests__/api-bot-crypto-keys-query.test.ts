import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { POST } from "@/app/api/bot/v1/crypto/keys/query/route";
import { db } from "@/lib/db";
import { bots, botDevices, userKeyBundles } from "@legends/db/schema";

let token: string;
let botId: string;
let peerUserId: string;
let peerBotId: string;

async function postQuery(body: unknown): Promise<Response> {
  return POST(new Request("http://t/bot/v1/crypto/keys/query", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("/api/bot/v1/crypto/keys/query", () => {
  beforeAll(async () => {
    const ownerId = randomUUID();
    peerUserId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'kq2'), (${peerUserId}, 'peer') ON CONFLICT DO NOTHING`);
    await db.insert(userKeyBundles).values({
      userId: peerUserId, deviceId: "UDV", identityPublicKey: "ed",
      algorithmsJson: ["m.olm.v1.curve25519-aes-sha2"],
      keysJson: { "ed25519:UDV": "ed" },
      signaturesJson: { [`@${peerUserId}:legends.local`]: { "ed25519:UDV": "s" } },
    });
    token = randomBytes(16).toString("hex");
    const [b1] = await db.insert(bots).values({
      name: `kqbot-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    }).returning({ id: bots.id });
    botId = b1!.id;
    const [b2] = await db.insert(bots).values({
      name: `kqpeerbot-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    }).returning({ id: bots.id });
    peerBotId = b2!.id;
    await db.insert(botDevices).values({
      botId: peerBotId, deviceId: "PB1",
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
      identityKeys: { "ed25519:PB1": "edpb" },
    });
  });

  it("queries a user", async () => {
    const res = await postQuery({ matrix_ids: [`@${peerUserId}:legends.local`] });
    const body = await res.json();
    expect(body.device_keys[`@${peerUserId}:legends.local`]).toBeDefined();
    expect(body.device_keys[`@${peerUserId}:legends.local`].UDV).toBeDefined();
  });

  it("queries another bot", async () => {
    const res = await postQuery({ matrix_ids: [`@bot.${peerBotId}:legends.local`] });
    const body = await res.json();
    expect(body.device_keys[`@bot.${peerBotId}:legends.local`].PB1).toBeDefined();
  });

  it("unknown matrix id returns empty entry", async () => {
    const res = await postQuery({ matrix_ids: [`@bot.${randomUUID()}:legends.local`] });
    const body = await res.json();
    const k = Object.keys(body.device_keys)[0]!;
    expect(body.device_keys[k]).toEqual({});
  });
});
