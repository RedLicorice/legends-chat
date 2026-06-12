import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegendsBot } from "../src/bot.js";

describe("LegendsBot — E2EE init", () => {
  let dir: string;
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bot-init-"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function mockGetMe(state: "disabled" | "pending" | "ready", deviceId: string | null = null): void {
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
              e2ee_state: state,
              e2ee_device_id: deviceId,
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
      return new Response("{}", { status: 200 });
    });
  }

  it("disabled: does not create the pickle file or load crypto", async () => {
    mockGetMe("disabled");
    const bot = new LegendsBot({
      token: "tok",
      baseUrl: "https://chat.test",
      cryptoStorePath: path.join(dir, "olm-store.pickle"),
    });
    await bot.loadBotInfoForTest();
    expect(bot.cryptoForTest()).toBeNull();
    await expect(stat(path.join(dir, "olm-store.pickle"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pending without pickle: bootstraps, writes pickle, calls keysUpload", async () => {
    mockGetMe("pending");
    const bot = new LegendsBot({
      token: "tok",
      baseUrl: "https://chat.test",
      cryptoStorePath: path.join(dir, "olm-store.pickle"),
    });
    await bot.loadBotInfoForTest();
    expect(bot.cryptoForTest()).not.toBeNull();
    const s = await stat(path.join(dir, "olm-store.pickle"));
    expect(s.isFile()).toBe(true);
    const calls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(calls).toContain("https://chat.test/api/bot/v1/crypto/keys/upload");
  });

  it("ready with existing pickle: loads pickle, does not re-bootstrap", async () => {
    mockGetMe("pending");
    const bot1 = new LegendsBot({
      token: "tok",
      baseUrl: "https://chat.test",
      cryptoStorePath: path.join(dir, "olm-store.pickle"),
    });
    await bot1.loadBotInfoForTest();
    const ed1 = bot1.cryptoForTest()!.getIdentityKeys().ed25519;

    fetchSpy.mockReset();
    mockGetMe("ready", "DEV-A");
    const bot2 = new LegendsBot({
      token: "tok",
      baseUrl: "https://chat.test",
      cryptoStorePath: path.join(dir, "olm-store.pickle"),
    });
    await bot2.loadBotInfoForTest();
    expect(bot2.cryptoForTest()).not.toBeNull();
    expect(bot2.cryptoForTest()!.getIdentityKeys().ed25519).toBe(ed1);
  });
});
