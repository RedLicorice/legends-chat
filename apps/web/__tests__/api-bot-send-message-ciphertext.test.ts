// POST /api/bot/v1/sendMessage — ciphertext extension (R2).
//
// Task 13 (R2): the existing sendMessage RPC must accept `ciphertext`
// alongside `text` for E2EE DM conversations. Plaintext path and topic
// branch must keep working unchanged. We cover:
//   - plaintext to plaintext DM → 201 (regression — must still work)
//   - ciphertext to E2EE DM → 201 + WS DM_NEW publish carries ciphertext
//   - plaintext to E2EE DM → 400 ("E2EE conversation; send ciphertext")
//   - ciphertext to plaintext DM → 400 ("plaintext conversation; send text")

import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const published: { channel: string; payload: unknown }[] = [];
vi.mock("@/lib/redis", () => ({
  redis: {
    publish: async (channel: string, val: string) => {
      published.push({ channel, payload: JSON.parse(val) });
      return 1;
    },
    rpush: async () => 1,
    expire: async () => 1,
  },
}));

const { POST } = await import("@/app/api/bot/v1/sendMessage/route");
const { db } = await import("@/lib/db");
const { bots, dmConversations, dmParticipants } = await import("@legends/db/schema");

let token: string;
let botId: string;
let ownerId: string;
let e2eeConvId: string;
let plaintextConvId: string;

async function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://t/bot/v1/sendMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("/api/bot/v1/sendMessage — ciphertext support", () => {
  beforeAll(async () => {
    ownerId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'sm-ct') ON CONFLICT DO NOTHING`,
    );
    token = randomBytes(16).toString("hex");
    const [b] = await db
      .insert(bots)
      .values({
        name: `sm-ct-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: ownerId,
        dmEnabled: true,
        tokenHash: createHash("sha256").update(token).digest("hex"),
      })
      .returning({ id: bots.id });
    botId = b!.id;

    const [e2ee] = await db
      .insert(dmConversations)
      .values({
        dmKey: `b:${botId}|u:${ownerId}|e|${Date.now()}-${Math.random().toString(36).slice(2)}`,
        isE2ee: true,
        state: "accepted",
        initiatorType: "user",
        initiatorId: ownerId,
      })
      .returning({ id: dmConversations.id });
    e2eeConvId = e2ee!.id;
    await db
      .update(dmConversations)
      .set({ e2eeRoomId: `!${e2eeConvId}:legends.local` })
      .where(sql`${dmConversations.id} = ${e2eeConvId}`);
    await db.insert(dmParticipants).values([
      { conversationId: e2eeConvId, principalType: "user", principalId: ownerId },
      { conversationId: e2eeConvId, principalType: "bot", principalId: botId },
    ]);

    const [pl] = await db
      .insert(dmConversations)
      .values({
        dmKey: `b:${botId}|u:${ownerId}|p|${Date.now()}-${Math.random().toString(36).slice(2)}`,
        isE2ee: false,
        state: "accepted",
        initiatorType: "user",
        initiatorId: ownerId,
      })
      .returning({ id: dmConversations.id });
    plaintextConvId = pl!.id;
    await db.insert(dmParticipants).values([
      { conversationId: plaintextConvId, principalType: "user", principalId: ownerId },
      { conversationId: plaintextConvId, principalType: "bot", principalId: botId },
    ]);
  });

  it("plaintext to plaintext convo: 201 (existing behavior preserved)", async () => {
    const res = await post({ conversationId: plaintextConvId, text: "hi" });
    expect(res.status).toBe(201);
  });

  it("ciphertext (JSON string per wire format) to E2EE convo: 201 + WS DM_NEW carries ciphertext", async () => {
    published.length = 0;
    const res = await post({
      conversationId: e2eeConvId,
      ciphertext: JSON.stringify({ algorithm: "m.olm.v1.curve25519-aes-sha2", x: 1 }),
    });
    expect(res.status).toBe(201);
    expect(published.length).toBeGreaterThanOrEqual(1);
    const env = published[0]!.payload as { conversationId: string; message: { ciphertext?: unknown }; isE2ee: boolean };
    expect(env.conversationId).toBe(e2eeConvId);
    expect(env.isE2ee).toBe(true);
    expect(env.message.ciphertext).toBeDefined();
  });

  it("ciphertext as object (legacy) is rejected — wire format is string", async () => {
    const res = await post({
      conversationId: e2eeConvId,
      ciphertext: { algorithm: "m.olm.v1.curve25519-aes-sha2", x: 1 },
    });
    expect(res.status).toBe(400);
  });

  it("plaintext to E2EE convo: 400", async () => {
    const res = await post({ conversationId: e2eeConvId, text: "hi" });
    expect(res.status).toBe(400);
  });

  it("ciphertext to plaintext convo: 400", async () => {
    const res = await post({ conversationId: plaintextConvId, ciphertext: JSON.stringify({ x: 1 }) });
    expect(res.status).toBe(400);
  });
});
