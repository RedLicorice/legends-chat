import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegendsBot } from "../src/bot.js";

/**
 * Exercises the background `_cryptoSyncLoop` (Task 23) — drains
 * `/api/bot/v1/crypto/sync` repeatedly, feeds the response into the wasm,
 * dispatches any new outgoing requests, and applies exponential backoff
 * on transport errors.
 */
describe("LegendsBot — crypto sync loop", () => {
  let dir: string;
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bot-sync-"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
    await resetIdb();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("drains one batch, then exits on stop()", async () => {
    let syncCalls = 0;
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
              e2ee_state: "ready",
              e2ee_device_id: "DEV-A",
            },
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://chat.test/api/bot/v1/crypto/sync")) {
        syncCalls++;
        return new Response(
          JSON.stringify({
            to_device: { events: [] },
            device_one_time_keys_count: { signed_curve25519: 50 },
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
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const bot = new LegendsBot({
      token: "tok",
      baseUrl: "https://chat.test",
      cryptoStorePath: path.join(dir, "bot.pickle"),
    });
    await bot.loadBotInfoForTest();
    const loop = bot.cryptoSyncLoopForTest();
    await new Promise((r) => setTimeout(r, 50));
    bot.stop();
    await loop;
    expect(syncCalls).toBeGreaterThan(0);
  });

  it("applies exponential backoff after a 503, then recovers", async () => {
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    // Replace setTimeout so we record the requested delay but run callbacks
    // immediately — keeps the test from sleeping for real backoff seconds.
    (globalThis as { setTimeout: typeof globalThis.setTimeout }).setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number,
    ) => {
      if (typeof ms === "number") delays.push(ms);
      return origSetTimeout(fn, 0);
    }) as unknown as typeof globalThis.setTimeout;

    let syncCalls = 0;
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
              e2ee_state: "ready",
              e2ee_device_id: "DEV-A",
            },
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://chat.test/api/bot/v1/crypto/sync")) {
        syncCalls++;
        if (syncCalls === 1) {
          return new Response(JSON.stringify({ error: "down" }), { status: 503 });
        }
        return new Response(
          JSON.stringify({
            to_device: { events: [] },
            device_one_time_keys_count: { signed_curve25519: 50 },
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
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    try {
      const bot = new LegendsBot({
        token: "tok",
        baseUrl: "https://chat.test",
        cryptoStorePath: path.join(dir, "bot.pickle"),
      });
      await bot.loadBotInfoForTest();
      const loop = bot.cryptoSyncLoopForTest();
      // Wait long enough that the loop has time to: (a) fail the first sync,
      // (b) record the backoff delay, (c) retry. The patched setTimeout
      // resolves instantly but the wasm machine's microtasks need a few
      // event-loop ticks.
      await new Promise((r) => origSetTimeout(r, 200));
      bot.stop();
      await loop;
      expect(delays).toContain(500);
      expect(syncCalls).toBeGreaterThanOrEqual(2);
    } finally {
      (globalThis as { setTimeout: typeof globalThis.setTimeout }).setTimeout = origSetTimeout;
    }
  });
});

async function resetIdb(): Promise<void> {
  const mod = await import("fake-indexeddb");
  const FactoryCtor = (mod as { IDBFactory: { new (): IDBFactory } }).IDBFactory;
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FactoryCtor();
}
