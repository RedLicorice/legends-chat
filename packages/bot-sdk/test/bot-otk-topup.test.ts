import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegendsBot } from "../src/bot.js";

/**
 * Verifies the OTK top-up path (Task 24): when `/api/bot/v1/crypto/sync`
 * reports `signed_curve25519` below the low-water mark, the wasm machine
 * emits a follow-up `keys_upload` request that the sync loop dispatches.
 *
 * The wasm's internal OTK accounting drives the actual decision — the
 * loop just needs to keep draining outgoing requests after every sync.
 */
describe("LegendsBot — OTK top-up", () => {
  let dir: string;
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bot-otk-"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
    await resetIdb();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uploads new OTKs when sync reports signed_curve25519 below the threshold", async () => {
    // Spy on console.log so we can verify the visible low-water guard log
    // fires when the wasm reports OTKs below `OTK_LOW_WATER`.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const uploadBodies: unknown[] = [];
    let syncCalls = 0;
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: "bot-a",
              name: "A",
              avatarUrl: null,
              webhookUrl: null,
              e2ee_state: "pending",
              e2ee_device_id: null,
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/upload")) {
        uploadBodies.push(JSON.parse(init!.body as string));
        return new Response(
          JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://chat.test/api/bot/v1/crypto/sync")) {
        syncCalls++;
        // Every sync reports 0 OTKs — the wasm should keep emitting
        // keys_upload requests as long as it sees the count below the
        // low-water threshold.
        return new Response(
          JSON.stringify({
            to_device: { events: [] },
            device_one_time_keys_count: { signed_curve25519: 0 },
          }),
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
    const initialUploads = uploadBodies.length;
    // Bootstrap step emits a keys_upload to publish the device + first
    // batch of OTKs.
    expect(initialUploads).toBeGreaterThan(0);

    const loop = bot.cryptoSyncLoopForTest();
    await new Promise((r) => setTimeout(r, 200));
    bot.stop();
    await loop;

    // After the sync that reported 0 OTKs the wasm must have emitted
    // another keys_upload that the loop dispatched.
    expect(uploadBodies.length).toBeGreaterThan(initialUploads);
    expect(syncCalls).toBeGreaterThan(0);

    // The low-water guard logged at least once when sync reported 0 OTKs.
    const lowWaterLog = logSpy.mock.calls.find((args) =>
      args.some((a) => typeof a === "string" && a.includes("OTK low")),
    );
    expect(lowWaterLog).toBeDefined();

    logSpy.mockRestore();
  });
});

async function resetIdb(): Promise<void> {
  const mod = await import("fake-indexeddb");
  const FactoryCtor = (mod as { IDBFactory: { new (): IDBFactory } }).IDBFactory;
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FactoryCtor();
}
