import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OlmStore } from "../../src/crypto/olm-store.js";
import { BotOlmMachine } from "../../src/crypto/olm-machine.js";

/**
 * Regression tests for the IndexedDB snapshot/restore round-trip.
 *
 * matrix-sdk-crypto-wasm creates object stores with specific `keyPath`s,
 * `autoIncrement` flags, and indices (e.g. `gossip_requests` has an `unsent`
 * index, `inbound_group_sessions3` has a composite
 * `inbound_group_session_sender_key_sender_data_type_idx` index). When
 * {@link BotOlmMachine} dumps + restores its IDB state via {@link OlmStore},
 * these schema elements MUST survive the round-trip — otherwise the wasm raises
 * `DOMException NotFoundError` the next time it tries to use one of those
 * indices (e.g. on every `outgoingRequests()` poll).
 *
 * Previously {@link restoreIdb} called `createObjectStore(name)` with no second
 * argument, dropping all schema. These tests pin the fix in place.
 */
describe("BotOlmMachine IDB snapshot/restore schema", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "olm-store-schema-"));
    await resetIdb();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("outgoingRequests() succeeds after a snapshot + reset + restore cycle", async () => {
    const storePath = path.join(dir, "store.pickle");

    // Bootstrap a fresh machine and persist.
    const store1 = new OlmStore(storePath);
    const m1 = await BotOlmMachine.create({ botId: "bot-a", store: store1 });
    await m1.persist();

    // Wipe in-memory IDB so the second instance is forced to restore from disk.
    await resetIdb();

    // Restore from the on-disk snapshot.
    const store2 = new OlmStore(storePath);
    const m2 = await BotOlmMachine.create({ botId: "bot-a", store: store2 });

    // The wasm queries indexed object stores (e.g. `gossip_requests.unsent`)
    // every time outgoingRequests() runs. Before the fix, the restored stores
    // had no indices and this call threw `NotFoundError (8)` on every poll.
    await expect(m2.outgoingRequests()).resolves.toBeDefined();
  });

  it("restored IDB preserves keyPath, autoIncrement, and indices for every store", async () => {
    const storePath = path.join(dir, "store.pickle");

    // Bootstrap so the wasm creates its real schema.
    const store1 = new OlmStore(storePath);
    const m1 = await BotOlmMachine.create({ botId: "bot-b", store: store1 });
    await m1.persist();

    // Capture the pre-restore schema (i.e. what wasm actually built).
    const before = await captureSchema((m1 as unknown as { storeName: string }).storeName);

    // Wipe in-memory IDB and restore.
    await resetIdb();
    const store2 = new OlmStore(storePath);
    const m2 = await BotOlmMachine.create({ botId: "bot-b", store: store2 });

    const after = await captureSchema((m2 as unknown as { storeName: string }).storeName);

    expect(after).toEqual(before);

    // Sanity: the round-tripped schema MUST include the known indexed stores;
    // otherwise the test could pass trivially if both snapshots dropped schema.
    const allIndices = after.flatMap((db) =>
      db.objectStores.flatMap((os) => os.indices.map((idx) => idx.name)),
    );
    expect(allIndices).toContain("unsent");
    expect(allIndices).toContain("inbound_group_session_sender_key_sender_data_type_idx");
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

interface SchemaIndex {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

interface SchemaObjectStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indices: SchemaIndex[];
}

interface SchemaDatabase {
  name: string;
  version: number;
  objectStores: SchemaObjectStore[];
}

async function captureSchema(storeName: string): Promise<SchemaDatabase[]> {
  const all = await indexedDB.databases();
  const matching = all.filter(
    (db) =>
      typeof db.name === "string" &&
      typeof db.version === "number" &&
      (db.name === storeName || db.name.startsWith(storeName + "::")),
  );
  const out: SchemaDatabase[] = [];
  for (const meta of matching) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(meta.name as string, meta.version as number);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const objectStoreNames = Array.from(db.objectStoreNames).sort();
      const objectStores: SchemaObjectStore[] = [];
      for (const osName of objectStoreNames) {
        const tx = db.transaction(osName, "readonly");
        const os = tx.objectStore(osName);
        const indices: SchemaIndex[] = [];
        for (const idxName of Array.from(os.indexNames).sort()) {
          const idx = os.index(idxName);
          indices.push({
            name: idx.name,
            keyPath: normalizeKeyPath(idx.keyPath) as string | string[],
            unique: idx.unique,
            multiEntry: idx.multiEntry,
          });
        }
        objectStores.push({
          name: os.name,
          keyPath: normalizeKeyPath(os.keyPath),
          autoIncrement: os.autoIncrement,
          indices,
        });
      }
      out.push({ name: meta.name as string, version: db.version, objectStores });
    } finally {
      db.close();
    }
  }
  // Sort for stable comparison.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function normalizeKeyPath(kp: string | string[] | null): string | string[] | null {
  if (kp === null || kp === undefined) return null;
  if (typeof kp === "string") return kp;
  // DOMStringList in some impls; fake-indexeddb returns plain arrays.
  return Array.from(kp as Iterable<string>);
}

async function resetIdb(): Promise<void> {
  const mod = await import("fake-indexeddb");
  const FactoryCtor = (mod as { IDBFactory: { new (): IDBFactory } }).IDBFactory;
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FactoryCtor();
}
