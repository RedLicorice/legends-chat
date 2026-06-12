import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegendsBot, DmMessageContext } from "../src/bot.js";

/**
 * Drives `DmMessageContext.reply()` through the new E2EE outgoing path
 * (Task 22). The flow under test:
 *
 *   1. Hit `/api/bot/v1/crypto/rooms/<roomId>` for the member list.
 *   2. (Indirectly via `getMissingSessions`) hit `/keys/claim` for Olm sessions.
 *   3. Drive Megolm `shareRoomKey` to-device requests via `sendToDevice`.
 *   4. Encrypt the plaintext + POST `/api/bot/v1/sendDmMessage`.
 *
 * The fetch mock answers each leg. We don't need a real peer machine —
 * the test only verifies that the SDK walks the sequence and that the
 * outbound ciphertext is non-empty.
 */
describe("LegendsBot — outgoing encrypt", () => {
  let dir: string;
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bot-out-"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
    await resetIdb();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ctx.reply on an E2EE DM walks the full key-share + encrypt + sendDmCiphertext sequence", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: "bot-a",
              name: "A",
              avatarUrl: null,
              webhookUrl: null,
              e2ee_state: "ready",
              e2ee_device_id: "DEV-A",
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/upload")) {
        return new Response(
          JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }),
          { status: 200 },
        );
      }
      if (url.includes("/api/bot/v1/crypto/rooms/")) {
        return new Response(
          JSON.stringify({ members: [{ matrix_id: "@user-a:legends.local", devices: ["DEV-U"] }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/query")) {
        return new Response(JSON.stringify({ device_keys: {} }), { status: 200 });
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/claim")) {
        return new Response(JSON.stringify({ one_time_keys: {} }), { status: 200 });
      }
      if (url.includes("/api/bot/v1/crypto/sendToDevice/")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.endsWith("/api/bot/v1/sendDmMessage")) {
        return new Response(
          JSON.stringify({ ok: true, result: { messageId: "m-out-1" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const bot = new LegendsBot({
      token: "tok",
      baseUrl: "https://chat.test",
      cryptoStorePath: path.join(dir, "bot.pickle"),
    });
    await bot.loadBotInfoForTest();

    const ctx = new DmMessageContext(
      bot,
      { update_id: "u", type: "dm_message" },
      {
        message_id: "m1",
        conversation_id: "conv1",
        from: { id: "user-a", display_name: "U" },
        text: "hi",
        ciphertext: undefined,
        e2ee_room_id: "!conv1:legends.local",
        sender_matrix_id: "@user-a:legends.local",
        date: 0,
      },
    );

    const out = await ctx.reply("hello back");
    expect(out.messageId).toBe("m-out-1");

    const paths = calls.map((c) => c.url);
    expect(paths.some((p) => p.includes("/crypto/rooms/"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/api/bot/v1/sendDmMessage"))).toBe(true);

    // Body shape: { conversationId, ciphertext } — R1.
    const sendCall = fetchSpy.mock.calls.find(
      (c) => (c[0] as string).endsWith("/api/bot/v1/sendDmMessage"),
    )!;
    const body = JSON.parse((sendCall[1] as RequestInit).body as string) as {
      conversationId: string;
      ciphertext: string;
    };
    expect(body.conversationId).toBe("conv1");
    expect(body.ciphertext.length).toBeGreaterThan(0);
  });

  it("ctx.reply on a non-E2EE DM falls back to sendMessage (plaintext)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: "bot-a",
              name: "A",
              avatarUrl: null,
              webhookUrl: null,
              e2ee_state: "disabled",
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/bot/v1/sendMessage")) {
        return new Response(
          JSON.stringify({ ok: true, result: { messageId: "m-plain" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const bot = new LegendsBot({
      token: "tok",
      baseUrl: "https://chat.test",
      cryptoStorePath: path.join(dir, "bot.pickle"),
    });
    await bot.loadBotInfoForTest();

    const ctx = new DmMessageContext(
      bot,
      { update_id: "u", type: "dm_message" },
      {
        message_id: "m1",
        conversation_id: "conv1",
        from: { id: "user-a", display_name: "U" },
        text: "hi",
        date: 0,
      },
    );

    const out = await ctx.reply("hello back");
    expect(out.messageId).toBe("m-plain");
  });
});

async function resetIdb(): Promise<void> {
  const mod = await import("fake-indexeddb");
  const FactoryCtor = (mod as { IDBFactory: { new (): IDBFactory } }).IDBFactory;
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FactoryCtor();
}
