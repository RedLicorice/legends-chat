// POST /api/dm/[id]/messages — bot delivery must fire on E2EE convos.
//
// The earlier route only invoked `deliverDmToBots` when the convo was
// plaintext (`!conv.isE2ee && parsed.data.text != null`). For E2EE bot DMs
// (user-side ciphertext-only) that left bot-participants without any update
// at all — the live-stack smoke test caught this. The fix: ALWAYS invoke
// `deliverDmToBots` after a successful insert, passing through whichever of
// `text` / `ciphertext` arrived. The helper itself already routes E2EE vs
// plaintext envelope shape (see Task 15 / dm-bot-delivery.test.ts).
//
// We use `vi.mock("@/lib/dm-bot-delivery")` to observe the call rather than
// asserting on the Redis push — that way this test is independent of the
// helper's internal shape and exclusively covers the route-side gate.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

let userId: string;
let botId: string;
let e2eeConvId: string;
let plaintextConvId: string;

vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({
    id: userId,
    role: "user",
    permissions: new Set<string>(),
    displayName: "u",
    avatarUrl: null,
    isAnon: false,
    presenceOptOut: false,
  }),
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    publish: async () => 1,
    rpush: async () => 1,
    expire: async () => 1,
  },
}));

const deliverCalls: Array<{ conversationId: string; msg: Record<string, unknown> }> = [];
vi.mock("@/lib/dm-bot-delivery", () => ({
  deliverDmToBots: async (conversationId: string, msg: Record<string, unknown>) => {
    deliverCalls.push({ conversationId, msg });
  },
}));

const { POST } = await import("@/app/api/dm/[id]/messages/route");
const { db } = await import("@/lib/db");
const { bots, dmConversations, dmParticipants } = await import("@legends/db/schema");

function makeReq(convId: string, body: unknown): {
  req: Request;
  params: Promise<{ id: string }>;
} {
  return {
    req: new Request(`http://t/api/dm/${convId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: Promise.resolve({ id: convId }),
  };
}

describe("POST /api/dm/[id]/messages — bot delivery covers E2EE convos", () => {
  beforeAll(async () => {
    userId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${userId}, 'dm-e2ee-sender') ON CONFLICT DO NOTHING`,
    );
    const [b] = await db
      .insert(bots)
      .values({
        name: `dme-${randomUUID()}`,
        ownerUserId: userId,
        dmEnabled: true,
        isActive: true,
        tokenHash: randomUUID(),
        e2eeState: "ready",
        e2eeDeviceId: "BDM1",
      })
      .returning({ id: bots.id });
    botId = b!.id;

    const [e] = await db
      .insert(dmConversations)
      .values({
        dmKey: `b:${botId}|u:${userId}|e|${randomUUID()}`,
        isE2ee: true,
        state: "accepted",
        initiatorType: "user",
        initiatorId: userId,
        e2eeRoomId: `!dm-${randomUUID()}:legends.local`,
      })
      .returning({ id: dmConversations.id });
    e2eeConvId = e!.id;
    await db.insert(dmParticipants).values([
      { conversationId: e2eeConvId, principalType: "user", principalId: userId },
      { conversationId: e2eeConvId, principalType: "bot", principalId: botId },
    ]);

    const [p] = await db
      .insert(dmConversations)
      .values({
        dmKey: `b:${botId}|u:${userId}|p|${randomUUID()}`,
        isE2ee: false,
        state: "accepted",
        initiatorType: "user",
        initiatorId: userId,
      })
      .returning({ id: dmConversations.id });
    plaintextConvId = p!.id;
    await db.insert(dmParticipants).values([
      { conversationId: plaintextConvId, principalType: "user", principalId: userId },
      { conversationId: plaintextConvId, principalType: "bot", principalId: botId },
    ]);
  });

  it("user → E2EE convo with ciphertext fires deliverDmToBots with ciphertext", async () => {
    deliverCalls.length = 0;
    const { req, params } = makeReq(e2eeConvId, {
      ciphertext: { algorithm: "m.olm.v1.curve25519-aes-sha2", x: 1 },
    });
    // Cast because the real handler takes NextRequest; Request shape is
    // compatible for what the route reads (json + nextUrl is not used in POST).
    const res = await POST(req as never, { params });
    expect(res.status).toBe(201);
    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0]!.conversationId).toBe(e2eeConvId);
    expect(deliverCalls[0]!.msg.ciphertext).toBeDefined();
  });

  it("user → plaintext convo still fires deliverDmToBots with text", async () => {
    deliverCalls.length = 0;
    const { req, params } = makeReq(plaintextConvId, { text: "hi bot" });
    const res = await POST(req as never, { params });
    expect(res.status).toBe(201);
    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0]!.conversationId).toBe(plaintextConvId);
    expect(deliverCalls[0]!.msg.text).toBe("hi bot");
  });
});
