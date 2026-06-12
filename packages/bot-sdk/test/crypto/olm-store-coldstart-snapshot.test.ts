import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OlmStore } from "../../src/crypto/olm-store.js";
import { BotOlmMachine } from "../../src/crypto/olm-machine.js";

/**
 * Cold-start regression test for the bot SDK Olm machine.
 *
 * Symptom seen in production (Jane bot):
 *   On a fresh bootstrap (no pickle on disk), the crypto sync loop runs
 *   `receiveSyncChanges` → `outgoingRequests` → `persist` per iteration. The
 *   loop produced `DomException NotFoundError (8)` on every iteration with a
 *   stack rooted entirely inside `matrix-sdk-crypto-wasm` — i.e. it was wasm
 *   itself failing, not our snapshot code.
 *
 * The root cause: `snapshotIdb` opens each backing IDB DB with the cached
 * version it got from `indexedDB.databases()`. matrix-sdk-crypto-wasm bumps the
 * version of those DBs while running (every time it creates a new object
 * store via `versionchange`). Between our enumerate and our open, wasm may
 * have raised the version. Opening with the now-stale version either:
 *   - blocks via `onblocked` while wasm holds a `versionchange` transaction,
 *     resolving to `null` and leaving wasm to retry forever, OR
 *   - succeeds at the stale version, which leaves the on-disk snapshot
 *     pinned to a schema wasm has already moved past.
 *
 * Fix: open without an explicit `version`, so IDB always uses the current
 * on-disk version. Capture the OPENED db's actual `db.version` into the
 * snapshot so `restoreIdb` recreates the DB at the version that was current
 * at snapshot time.
 *
 * This test pins both invariants by running a minimal cold-start sync-loop
 * iteration: bootstrap → persist → receiveSyncChanges (empty) →
 * outgoingRequests → persist again. Before the fix the second persist drove
 * the same race as the bot's `_cryptoSyncLoop`.
 */
describe("BotOlmMachine cold-start snapshot", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "olm-coldstart-"));
    await resetIdb();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persist() never opens a DB at a stale version (no version arg)", async () => {
    // Wrap indexedDB.open so we can spy on every version argument the bot SDK
    // passes. The bug: snapshotIdb passes a version it cached ahead of time.
    // The fix: snapshotIdb opens with no version so IDB uses the current one.
    const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
    const originalOpen = idb.open.bind(idb);
    const openCalls: Array<{ name: string; version: number | undefined }> = [];
    (idb as unknown as { open: typeof idb.open }).open = ((
      name: string,
      version?: number,
    ) => {
      openCalls.push({ name, version });
      return version === undefined ? originalOpen(name) : originalOpen(name, version);
    }) as typeof idb.open;

    try {
      const storePath = path.join(dir, "store.pickle");
      const store = new OlmStore(storePath);
      const m = await BotOlmMachine.create({ botId: "bot-cold", store });

      // Drain the keys_upload that bootstrap emits — mirrors `_initCrypto`'s
      // cold-start branch in bot.ts so wasm internal state matches what the
      // production sync loop sees on the first persist.
      const reqs = await m.outgoingRequests();
      for (const r of reqs) {
        if (r.type === "keys_upload") {
          await m.markRequestAsSent(
            r.id,
            JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }),
          );
        }
      }
      await m.persist();

      // Reset our spy log to only count opens performed by `snapshotIdb` /
      // `restoreIdb`. Drain again to mimic the sync loop, then persist a
      // second time. Production hits this path every iteration.
      openCalls.length = 0;
      await m.receiveSyncChanges({ toDevice: "[]", otkCounts: {} });
      await m.outgoingRequests();
      await m.persist();

      // Every open this code path performed must have been version-less so
      // it can never race wasm's own versionchange-driven schema bumps.
      const snapshotOpensWithVersion = openCalls.filter(
        (c) => c.name.startsWith("legends-bot-bot-cold") && c.version !== undefined,
      );
      expect(snapshotOpensWithVersion).toEqual([]);
    } finally {
      (idb as unknown as { open: typeof idb.open }).open = originalOpen;
    }
  });

  it("snapshot envelope's per-DB version reflects the live IDB version at snapshot time", async () => {
    // Bootstrap, persist, then artificially bump one of wasm's DBs to N+1 via
    // a no-op versionchange. The next persist must capture version=N+1, not
    // the stale N we'd have if `snapshotIdb` re-used the version from
    // `indexedDB.databases()` collected before the bump.
    const storePath = path.join(dir, "store.pickle");
    const store = new OlmStore(storePath);
    const m = await BotOlmMachine.create({ botId: "bot-bump", store });
    await m.persist();

    const dbs = await indexedDB.databases();
    const target = dbs.find((d) => typeof d.name === "string" && d.name.startsWith("legends-bot-bot-bump"));
    if (!target || typeof target.name !== "string" || typeof target.version !== "number") {
      throw new Error("test setup: expected at least one legends-bot-bot-bump DB");
    }
    const bumpedVersion = target.version + 1;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(target.name as string, bumpedVersion);
      req.onupgradeneeded = () => { /* no schema change, just a version bump */ };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    await m.persist();

    const blob = await store.load();
    if (!blob) throw new Error("test setup: snapshot blob missing after persist");
    const env = JSON.parse(new TextDecoder().decode(blob)) as {
      databases: Array<{ name: string; version: number }>;
    };
    const captured = env.databases.find((d) => d.name === target.name);
    expect(captured?.version).toBe(bumpedVersion);
  });
});

async function resetIdb(): Promise<void> {
  const mod = await import("fake-indexeddb");
  const FactoryCtor = (mod as { IDBFactory: { new (): IDBFactory } }).IDBFactory;
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FactoryCtor();
}
