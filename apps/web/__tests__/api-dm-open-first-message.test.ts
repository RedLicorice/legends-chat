// POST /api/dm — first-message contract.
//
// Refactor: openConversation now takes an optional `firstMessage` in options
// and requires it for user peers (rejected with BAD/"first message required").
// Bot peers may omit it (auto-accept, no pending request to gate). The route
// is responsible for plumbing the body field through to the lib call; this
// test stays at the route layer (mocks @/lib/dm) since the lib's own
// behavior is exercised in dm-bot-e2ee-gate.test.ts and the new DB-backed
// decline test.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

type OpenArgs = {
  initiatorUserId: string;
  peer: { type: "user" | "bot"; id: string };
  options?: { e2ee?: boolean; firstMessage?: { text?: string; ciphertext?: unknown } };
};

const state = {
  lastCall: null as OpenArgs | null,
  user: { id: randomUUID(), isAnon: false } as { id: string; isAnon: boolean } | null,
  throwBad: false,
};

vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => Promise.resolve(state.user),
}));

vi.mock("@/lib/dm", () => ({
  openConversation: async (
    initiatorUserId: string,
    peer: { type: "user" | "bot"; id: string },
    options?: { e2ee?: boolean; firstMessage?: { text?: string; ciphertext?: unknown } },
  ) => {
    state.lastCall = { initiatorUserId, peer, options };
    if (state.throwBad) {
      throw Object.assign(new Error("first message required"), { code: "BAD" });
    }
    return { id: "conv-1", created: true, e2eeRoomId: null };
  },
  listConversations: async () => [],
}));

const { POST } = await import("@/app/api/dm/route");

function postReq(body: unknown): Request {
  return new Request("http://t/api/dm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.lastCall = null;
  state.throwBad = false;
  state.user = { id: randomUUID(), isAnon: false };
});

describe("POST /api/dm first-message plumbing", () => {
  it("plumbs firstMessage.text through to openConversation for user peers", async () => {
    const peerId = randomUUID();
    const res = await POST(
      postReq({
        peerType: "user",
        peerId,
        firstMessage: { text: "hello world" },
      }),
    );
    expect(res.status).toBe(201);
    expect(state.lastCall?.peer).toEqual({ type: "user", id: peerId });
    expect(state.lastCall?.options?.firstMessage).toEqual({ text: "hello world" });
  });

  it("propagates BAD as 400 when openConversation rejects missing firstMessage", async () => {
    state.throwBad = true;
    const res = await POST(
      postReq({ peerType: "user", peerId: randomUUID() }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("first message required");
  });

  it("allows omitting firstMessage for bot peers (auto-accept path)", async () => {
    const peerId = randomUUID();
    const res = await POST(
      postReq({ peerType: "bot", peerId }),
    );
    expect(res.status).toBe(201);
    expect(state.lastCall?.peer).toEqual({ type: "bot", id: peerId });
    expect(state.lastCall?.options?.firstMessage).toBeUndefined();
  });

  it("rejects bodies where firstMessage has both text and ciphertext", async () => {
    const res = await POST(
      postReq({
        peerType: "user",
        peerId: randomUUID(),
        firstMessage: { text: "x", ciphertext: { algorithm: "olm" } },
      }),
    );
    // Zod refine triggers — schema-validation 400 from the route guard.
    expect(res.status).toBe(400);
    // openConversation should not have been called.
    expect(state.lastCall).toBeNull();
  });
});
