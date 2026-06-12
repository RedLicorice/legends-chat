// POST /api/bot/v1/sendDmMessage
//
// Task 13 (per INDEX reconciliation R1): RPC-shaped bot DM send. Body is
// `{ conversationId, text? | ciphertext? }` to mirror the existing
// sendMessage SDK pattern. The route enforces:
//   - bot bearer auth
//   - bot is a participant of the conversation
//   - convo not blocked
//   - E2EE convo ⇒ ciphertext required; plaintext convo ⇒ text required
// On success it inserts the dm_messages row, publishes the WS DM_MESSAGE_NEW
// event so users receive the ciphertext or text via the existing path, and
// fans out to any other bot participants via deliverDmToBots.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";

// Stub Redis so the route can publish/rpush without a real connection.
const published: { channel: string; payload: unknown }[] = [];
const pushed: { key: string; payload: unknown }[] = [];
vi.mock("@/lib/redis", () => ({
  redis: {
    publish: async (channel: string, val: string) => {
      published.push({ channel, payload: JSON.parse(val) });
      return 1;
    },
    rpush: async (key: string, val: string) => {
      pushed.push({ key, payload: JSON.parse(val) });
      return 1;
    },
    expire: async () => 1,
  },
}));

const { POST } = await import("@/app/api/bot/v1/sendDmMessage/route");
const { db } = await import("@/lib/db");
const { bots, dmConversations, dmParticipants } = await import("@legends/db/schema");

let token: string;
let botId: string;
let ownerId: string;
let e2eeConvId: string;
let plaintextConvId: string;

async function post(body: unknown, withToken = true): Promise<Response> {
  return POST(
    new Request("http://t/bot/v1/sendDmMessage", {
      method: "POST",
      headers: {
        ...(withToken ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("/api/bot/v1/sendDmMessage", () => {
  beforeAll(async () => {
    ownerId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'sdm') ON CONFLICT DO NOTHING`,
    );
    token = randomBytes(16).toString("hex");
    const [b] = await db
      .insert(bots)
      .values({
        name: `sdm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  it("ciphertext to E2EE convo: 201 + publishes DM_NEW with ciphertext", async () => {
    published.length = 0;
    const res = await post({
      conversationId: e2eeConvId,
      ciphertext: { algorithm: "m.olm.v1.curve25519-aes-sha2", x: 1 },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.messageId).toMatch(/^\d+$/);
    expect(published.length).toBeGreaterThanOrEqual(1);
    const env = published[0]!.payload as { conversationId: string; message: { ciphertext?: unknown }; isE2ee: boolean };
    expect(env.conversationId).toBe(e2eeConvId);
    expect(env.isE2ee).toBe(true);
    expect(env.message.ciphertext).toBeDefined();
  });

  it("plaintext to plaintext convo: 201", async () => {
    const res = await post({ conversationId: plaintextConvId, text: "hi" });
    expect(res.status).toBe(201);
  });

  it("plaintext to E2EE convo: 400", async () => {
    const res = await post({ conversationId: e2eeConvId, text: "hi" });
    expect(res.status).toBe(400);
  });

  it("ciphertext to plaintext convo: 400", async () => {
    const res = await post({ conversationId: plaintextConvId, ciphertext: { x: 1 } });
    expect(res.status).toBe(400);
  });

  it("missing both text and ciphertext: 400", async () => {
    const res = await post({ conversationId: plaintextConvId });
    expect(res.status).toBe(400);
  });

  it("both text and ciphertext: 400", async () => {
    const res = await post({ conversationId: plaintextConvId, text: "x", ciphertext: { x: 1 } });
    expect(res.status).toBe(400);
  });

  it("bot not in conversation: 403", async () => {
    const otherUserId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${otherUserId}, 'sdm-x') ON CONFLICT DO NOTHING`,
    );
    const [other] = await db
      .insert(dmConversations)
      .values({
        dmKey: `u:${otherUserId}|u:${ownerId}|${Date.now()}-${Math.random().toString(36).slice(2)}`,
        isE2ee: false,
        state: "accepted",
        initiatorType: "user",
        initiatorId: ownerId,
      })
      .returning({ id: dmConversations.id });
    await db.insert(dmParticipants).values([
      { conversationId: other!.id, principalType: "user", principalId: ownerId },
      { conversationId: other!.id, principalType: "user", principalId: otherUserId },
    ]);
    const res = await post({ conversationId: other!.id, text: "hi" });
    expect(res.status).toBe(403);
  });

  it("conversation not found: 404", async () => {
    const res = await post({ conversationId: randomUUID(), text: "hi" });
    expect(res.status).toBe(404);
  });

  it("missing bearer: 401", async () => {
    const res = await post({ conversationId: plaintextConvId, text: "hi" }, false);
    expect(res.status).toBe(401);
  });
});
