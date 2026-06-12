// POST /api/dm — bot E2EE error code mapping.
//
// Finding 9: openConversation now throws errors with code values matching
// BOT_E2EE_ERROR_CODES (bot_e2ee_disabled / bot_e2ee_not_ready). The /api/dm
// catch only mapped legacy 'BLOCKED' and 'BAD' codes, so the new codes fell
// through to a 500 — losing the structured client-side branch the frontend
// uses to render specific UX. This test covers the catch-side mapping.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { BOT_E2EE_ERROR_CODES } from "@legends/shared";

const state = {
  thrown: null as Error | null,
  user: { id: randomUUID(), isAnon: false } as { id: string; isAnon: boolean } | null,
};

vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => Promise.resolve(state.user),
}));

vi.mock("@/lib/dm", () => ({
  openConversation: async () => {
    if (state.thrown) throw state.thrown;
    return { id: "conv-1", created: true, e2eeRoomId: "!conv-1:legends.local" };
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
  state.thrown = null;
  state.user = { id: randomUUID(), isAnon: false };
});

describe("POST /api/dm bot E2EE error code mapping", () => {
  it("BOT_E2EE_DISABLED → 400 with {error:'bot_e2ee_disabled'}", async () => {
    state.thrown = Object.assign(new Error("bot e2ee disabled"), {
      code: BOT_E2EE_ERROR_CODES.BOT_E2EE_DISABLED,
    });
    const res = await POST(postReq({ peerType: "bot", peerId: randomUUID(), e2ee: true }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(BOT_E2EE_ERROR_CODES.BOT_E2EE_DISABLED);
  });

  it("BOT_E2EE_NOT_READY → 400 with {error:'bot_e2ee_not_ready'}", async () => {
    state.thrown = Object.assign(new Error("bot e2ee not ready"), {
      code: BOT_E2EE_ERROR_CODES.BOT_E2EE_NOT_READY,
    });
    const res = await POST(postReq({ peerType: "bot", peerId: randomUUID(), e2ee: true }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(BOT_E2EE_ERROR_CODES.BOT_E2EE_NOT_READY);
  });

  it("BLOCKED still maps to 403 (regression)", async () => {
    state.thrown = Object.assign(new Error("blocked"), { code: "BLOCKED" });
    const res = await POST(postReq({ peerType: "user", peerId: randomUUID() }));
    expect(res.status).toBe(403);
  });

  it("BAD still maps to 400 (regression)", async () => {
    state.thrown = Object.assign(new Error("bad input"), { code: "BAD" });
    const res = await POST(postReq({ peerType: "user", peerId: randomUUID() }));
    expect(res.status).toBe(400);
  });

  it("unknown error still bubbles (500)", async () => {
    state.thrown = new Error("kaboom");
    await expect(POST(postReq({ peerType: "user", peerId: randomUUID() }))).rejects.toThrow();
  });
});
