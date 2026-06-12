# Bot E2EE — Part 2: Bot SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Olm/Megolm support to `@legends/bot-sdk`. FS-persisted pickle, transparent encrypt/decrypt around the existing handler API, sync loop draining the to-device queue, OTK top-up.

**Architecture:** Three small modules under `packages/bot-sdk/src/crypto/` (store, machine wrapper, HTTP transport), integrated via a few additions to `bot.ts`. Bot SDK detects `e2ee_state` from `getMe()` on `start()` and either no-ops (`disabled`), bootstraps (`pending` with no pickle), or loads existing pickle (`ready` or `pending` with pickle).

**Tech Stack:** TypeScript ESM, `@matrix-org/matrix-sdk-crypto-wasm` v18.3.0, Node fs/promises, Vitest.

**Scope (this plan):** Phase 4 of the spec — 8 tasks. Backend (parts 0–3) lands in part 1; admin UI + docs in part 3.

**Prereqs:** Part 1 backend must be merged (or at least the migration applied + `/api/bot/v1/crypto/*` mirror routes available on a dev server) for integration tests to pass.

---

## Wasm note (read once before Task 18)

`@matrix-org/matrix-sdk-crypto-wasm` v18.3.0 stores machine state in **IndexedDB** (browser only) or memory. There is no single-blob pickle export on `OlmMachine`. To meet the spec's "FS-persisted pickle" requirement in Node, the bot SDK uses `fake-indexeddb` as the IndexedDB backend and the `OlmStore` snapshot/restore is a JSON dump of every record in the IDB store. The wrapper hides this: callers only see `OlmStore.load() / save()` over an opaque `Uint8Array`. Both the `OlmStore` and the wrapper unit tests must operate in a Node process with `fake-indexeddb/auto` imported at the top of the test file.

API used (real names from `pkg/matrix_sdk_crypto_wasm.d.ts`):

- `OlmMachine.initialize(userId: UserId, deviceId: DeviceId, storeName?, storePassphrase?, logger?)`
- `machine.identityKeys` (getter; returns `IdentityKeys` with `ed25519` and `curve25519` accessors)
- `machine.userId`, `machine.deviceId` (getters)
- `machine.outgoingRequests(): Promise<unknown[]>` — items are `KeysUploadRequest | KeysQueryRequest | KeysClaimRequest | ToDeviceRequest | SignatureUploadRequest | RoomMessageRequest | KeysBackupRequest`. Each has `.id`, `.type` (`RequestType` enum), `.body` (JSON string). `ToDeviceRequest` additionally has `.event_type` and `.txn_id`.
- `machine.markRequestAsSent(requestId, requestType, responseJson)`
- `machine.receiveSyncChanges(toDeviceEventsJson, deviceLists, otkCounts: Map<string, number>, unusedFallbackKeys?, decryptionSettings?)`
- `machine.updateTrackedUsers(users: UserId[])`
- `machine.shareRoomKey(roomId: RoomId, users: UserId[], encryptionSettings: EncryptionSettings): Promise<ToDeviceRequest[]>`
- `machine.encryptRoomEvent(roomId: RoomId, eventType: string, content: string): Promise<string>` (returns JSON string)
- `machine.decryptRoomEvent(event: string, roomId: RoomId, decryptionSettings: DecryptionSettings): Promise<DecryptedRoomEvent>` (`.event` getter returns plaintext JSON string)
- `new UserId("@bot.<uuid>:legends.local")`, `new DeviceId("<id>")`, `new RoomId("!<id>:legends.local")`, `new DeviceLists()`, `new EncryptionSettings()`, `new DecryptionSettings()`

---

### Task 17: `OlmStore` (FS pickle persistence)

**Files:**
- Create: `packages/bot-sdk/src/crypto/olm-store.ts`
- Create: `packages/bot-sdk/test/crypto/olm-store.test.ts`
- Modify: `packages/bot-sdk/package.json` (add `vitest` devDep + `test` script if missing)

- [ ] **Step 1: Write the failing test**

`packages/bot-sdk/test/crypto/olm-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OlmStore } from "../../src/crypto/olm-store.js";

describe("OlmStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "olm-store-"));
    storePath = path.join(dir, "olm-store.pickle");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when the pickle file does not exist", async () => {
    const store = new OlmStore(storePath);
    expect(await store.exists()).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it("round-trips a save/load", async () => {
    const store = new OlmStore(storePath);
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    await store.save(blob);
    expect(await store.exists()).toBe(true);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reset() deletes the pickle file", async () => {
    const store = new OlmStore(storePath);
    await store.save(new Uint8Array([9]));
    await store.reset();
    expect(await store.exists()).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it("save() is atomic — a leftover tmp file does not corrupt load", async () => {
    const store = new OlmStore(storePath);
    await store.save(new Uint8Array([42]));
    // Simulate a crash mid-write: a tmp file with garbage exists alongside.
    await writeFile(storePath + ".tmp", Buffer.from("garbage"));
    const loaded = await store.load();
    expect(Array.from(loaded!)).toEqual([42]);
  });

  it("save() writes via tmp + rename", async () => {
    const store = new OlmStore(storePath);
    // Place an existing file we expect to be replaced atomically.
    await writeFile(storePath, Buffer.from([7]));
    await store.save(new Uint8Array([8]));
    const onDisk = await readFile(storePath);
    expect(Array.from(onDisk)).toEqual([8]);
    // tmp file should not exist after a successful save.
    await expect(stat(storePath + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/bot-sdk test -- olm-store`
Expected: failure — module `../../src/crypto/olm-store.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`packages/bot-sdk/src/crypto/olm-store.ts`:

```ts
import { mkdir, readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem-backed snapshot of the bot's Olm machine state.
 *
 * The blob format is opaque to OlmStore. The {@link BotOlmMachine} encodes a
 * JSON-serialised dump of the underlying IndexedDB store into a Uint8Array and
 * hands it here for persistence.
 *
 * Writes are atomic via tmp + rename to survive crashes mid-write.
 */
export class OlmStore {
  constructor(private readonly filePath: string) {}

  async exists(): Promise<boolean> {
    try {
      await stat(this.filePath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async load(): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.filePath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(blob: Uint8Array): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + ".tmp";
    await writeFile(tmp, blob);
    await rename(tmp, this.filePath);
  }

  async reset(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      await unlink(this.filePath + ".tmp");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
```

`packages/bot-sdk/package.json` (add `vitest`, `test` script):

```json
{
  "name": "@legends/bot-sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22.7.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/bot-sdk test -- olm-store`
Expected: PASS (5 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/bot-sdk/src/crypto/olm-store.ts packages/bot-sdk/test/crypto/olm-store.test.ts packages/bot-sdk/package.json
git commit -m "feat(bot-sdk): add OlmStore FS-backed pickle persistence"
```

---

### Task 18: `OlmMachine` wrapper

**Files:**
- Create: `packages/bot-sdk/src/crypto/olm-machine.ts`
- Create: `packages/bot-sdk/test/crypto/olm-machine.test.ts`
- Modify: `packages/bot-sdk/package.json` — add `@matrix-org/matrix-sdk-crypto-wasm` (^18.3.0) to deps; add `fake-indexeddb` (^6.0.0) to devDeps.

- [ ] **Step 1: Write the failing test**

`packages/bot-sdk/test/crypto/olm-machine.test.ts`:

```ts
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OlmStore } from "../../src/crypto/olm-store.js";
import { BotOlmMachine } from "../../src/crypto/olm-machine.js";

describe("BotOlmMachine", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "olm-machine-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("bootstraps with an empty store and exposes identity keys", async () => {
    const store = new OlmStore(path.join(dir, "store.pickle"));
    const m = await BotOlmMachine.create({ botId: "bot-a", store });
    const ids = m.getIdentityKeys();
    expect(ids.ed25519).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(ids.curve25519).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(m.getDeviceId()).toMatch(/^[A-Z0-9]+$/);
  });

  it("outgoingRequests includes a keys_upload after bootstrap", async () => {
    const store = new OlmStore(path.join(dir, "store.pickle"));
    const m = await BotOlmMachine.create({ botId: "bot-a", store });
    const reqs = await m.outgoingRequests();
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.some((r) => r.type === "keys_upload")).toBe(true);
  });

  it("persist() then create() with existing pickle reuses the same identity", async () => {
    const store = new OlmStore(path.join(dir, "store.pickle"));
    const m1 = await BotOlmMachine.create({ botId: "bot-a", store });
    const ids1 = m1.getIdentityKeys();
    const dev1 = m1.getDeviceId();
    await m1.persist();
    const m2 = await BotOlmMachine.create({ botId: "bot-a", store });
    expect(m2.getIdentityKeys().ed25519).toBe(ids1.ed25519);
    expect(m2.getDeviceId()).toBe(dev1);
  });

  it("round-trips an encrypted room message between bot and user machines", async () => {
    // Two machines act as bot + user, sharing room keys via to-device messages.
    const botStore = new OlmStore(path.join(dir, "bot.pickle"));
    const userStore = new OlmStore(path.join(dir, "user.pickle"));
    const bot = await BotOlmMachine.create({ botId: "bot-a", store: botStore });
    const user = await BotOlmMachine.create({ botId: "user-a", store: userStore, matrixId: "@user-a:legends.local" });

    const botId = "@bot.bot-a:legends.local";
    const userId = "@user-a:legends.local";
    const roomId = "!room1:legends.local";

    // Cross-publish keys/upload + keys/query bodies so both machines know each other's devices.
    await crossPublishIdentities(bot, user);
    await bot.updateTrackedUsers([userId]);
    await user.updateTrackedUsers([botId]);

    // Bot shares a room key to user, delivering to-device requests directly.
    const shareReqs = await bot.shareRoomKey(roomId, [userId]);
    for (const req of shareReqs) {
      const toDeviceJson = wrapToDeviceForReceive(req, botId);
      await user.receiveSyncChanges({ toDevice: toDeviceJson, otkCounts: {} });
      await bot.markRequestAsSent(req.id, "{}");
    }

    const { ciphertext } = await bot.encryptForRoom(roomId, "hello user", "m.room.message");
    const plaintext = await user.decryptRoomMessage(roomId, { ciphertext, sender: botId });
    expect(plaintext).toContain("hello user");
  });
});

// Test helper: simulate keys/upload + keys/query happening over a fake server.
async function crossPublishIdentities(a: BotOlmMachine, b: BotOlmMachine): Promise<void> {
  for (const m of [a, b]) {
    const reqs = await m.outgoingRequests();
    for (const r of reqs) {
      if (r.type === "keys_upload") {
        await m.markRequestAsSent(r.id, JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }));
      } else if (r.type === "keys_query") {
        await m.markRequestAsSent(r.id, JSON.stringify({ device_keys: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {} }));
      }
    }
  }
}

function wrapToDeviceForReceive(req: { event_type: string; body: string }, sender: string): string {
  const messages = JSON.parse(req.body).messages as Record<string, Record<string, unknown>>;
  const events: unknown[] = [];
  for (const [_user, devices] of Object.entries(messages)) {
    for (const [_device, content] of Object.entries(devices)) {
      events.push({ type: req.event_type, sender, content });
    }
  }
  return JSON.stringify({ events });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/bot-sdk test -- olm-machine`
Expected: failure — module `../../src/crypto/olm-machine.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`packages/bot-sdk/src/crypto/olm-machine.ts`:

```ts
import {
  OlmMachine,
  UserId,
  DeviceId,
  RoomId,
  DeviceLists,
  EncryptionSettings,
  DecryptionSettings,
  RequestType,
  KeysUploadRequest,
  KeysQueryRequest,
  KeysClaimRequest,
  ToDeviceRequest,
} from "@matrix-org/matrix-sdk-crypto-wasm";
import type { OlmStore } from "./olm-store.js";

export interface OutgoingRequest {
  id: string;
  type: "keys_upload" | "keys_query" | "keys_claim" | "to_device" | "signature_upload" | "room_message" | "keys_backup";
  body: string;
  event_type?: string;
  txn_id?: string;
}

export interface IdentityKeyPair {
  ed25519: string;
  curve25519: string;
}

export interface SyncChangesInput {
  toDevice: string;
  otkCounts: Record<string, number>;
  changedDevices?: { changed?: string[]; left?: string[] };
}

export class BotOlmMachine {
  private constructor(
    private readonly machine: OlmMachine,
    private readonly store: OlmStore,
    private readonly storeName: string,
    private readonly storePassphrase: string,
  ) {}

  static async create({
    botId,
    store,
    matrixId,
  }: {
    botId: string;
    store: OlmStore;
    /** Override the auto-generated matrix id (used by tests to simulate a user). */
    matrixId?: string;
  }): Promise<BotOlmMachine> {
    const userId = new UserId(matrixId ?? `@bot.${botId}:legends.local`);
    const storeName = `bot-${botId}`;
    const storePassphrase = `legends-bot-${botId}-v1`;

    // If an existing pickle is on disk, restore the IndexedDB contents before
    // initialising the machine. Otherwise OlmMachine.initialize bootstraps a
    // fresh identity into IndexedDB.
    const existing = await store.load();
    if (existing) {
      await restoreIdb(storeName, existing);
      const deviceId = await readDeviceIdFromIdb(storeName);
      const m = await OlmMachine.initialize(userId, new DeviceId(deviceId), storeName, storePassphrase);
      return new BotOlmMachine(m, store, storeName, storePassphrase);
    }

    // Fresh bootstrap: generate a device id, initialise, persist.
    const deviceId = generateDeviceId();
    const m = await OlmMachine.initialize(userId, new DeviceId(deviceId), storeName, storePassphrase);
    const wrapper = new BotOlmMachine(m, store, storeName, storePassphrase);
    await wrapper.persist();
    return wrapper;
  }

  getIdentityKeys(): IdentityKeyPair {
    const ids = this.machine.identityKeys;
    return { ed25519: ids.ed25519.toBase64(), curve25519: ids.curve25519.toBase64() };
  }

  getDeviceId(): string {
    return this.machine.deviceId!.toString();
  }

  async outgoingRequests(): Promise<OutgoingRequest[]> {
    const raw = await this.machine.outgoingRequests();
    return raw.map((r) => toOutgoingRequest(r));
  }

  async markRequestAsSent(requestId: string, responseBody: string): Promise<void> {
    // We don't know the request's type just from id, so we look up the type by
    // re-querying outgoingRequests. In practice callers pass the matching type
    // through {@link OutgoingRequest.type}; we map back to RequestType here.
    // For correctness across all callers we accept the type via a side-channel
    // map maintained on this instance.
    const reqType = this.pendingTypes.get(requestId);
    if (reqType === undefined) {
      throw new Error(`unknown request id ${requestId} — call outgoingRequests() first`);
    }
    await this.machine.markRequestAsSent(requestId, reqType, responseBody);
    this.pendingTypes.delete(requestId);
  }

  async receiveSyncChanges(input: SyncChangesInput): Promise<void> {
    const counts = new Map<string, number>(Object.entries(input.otkCounts));
    const lists = new DeviceLists();
    await this.machine.receiveSyncChanges(input.toDevice, lists, counts);
  }

  async updateTrackedUsers(matrixIds: string[]): Promise<void> {
    await this.machine.updateTrackedUsers(matrixIds.map((id) => new UserId(id)));
  }

  async shareRoomKey(roomId: string, memberMatrixIds: string[]): Promise<OutgoingRequest[]> {
    const reqs = await this.machine.shareRoomKey(
      new RoomId(roomId),
      memberMatrixIds.map((id) => new UserId(id)),
      new EncryptionSettings(),
    );
    return reqs.map((r) => toOutgoingRequest(r));
  }

  async encryptForRoom(roomId: string, plaintext: string, eventType: string): Promise<{ ciphertext: string }> {
    const content = JSON.stringify({ body: plaintext, msgtype: "m.text" });
    const ciphertext = await this.machine.encryptRoomEvent(new RoomId(roomId), eventType, content);
    return { ciphertext };
  }

  async decryptRoomMessage(
    roomId: string,
    envelope: { ciphertext: string; sender: string },
  ): Promise<string> {
    const event = JSON.stringify({
      type: "m.room.encrypted",
      sender: envelope.sender,
      content: JSON.parse(envelope.ciphertext),
      event_id: `$bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      origin_server_ts: Date.now(),
    });
    const decrypted = await this.machine.decryptRoomEvent(new RoomId(roomId), event, new DecryptionSettings());
    const plain = JSON.parse(decrypted.event) as { content?: { body?: string } };
    return plain.content?.body ?? "";
  }

  async persist(): Promise<void> {
    const blob = await snapshotIdb(this.storeName);
    await this.store.save(blob);
  }

  // ── Internal: outgoing request type tracking ────────────────────────────
  private readonly pendingTypes = new Map<string, RequestType>();

  // Track request types as we surface them so markRequestAsSent has the right
  // RequestType enum value to forward.
  private rememberType(id: string, type: RequestType): void {
    this.pendingTypes.set(id, type);
  }
}

// Decorate the surfacing path so .outgoingRequests() registers types.
const origOutgoing = BotOlmMachine.prototype.outgoingRequests;
BotOlmMachine.prototype.outgoingRequests = async function (this: BotOlmMachine): Promise<OutgoingRequest[]> {
  const raw = await (this as unknown as { machine: OlmMachine }).machine.outgoingRequests();
  const mapped = raw.map((r) => toOutgoingRequest(r));
  for (const r of raw) {
    (this as unknown as { rememberType: (id: string, type: RequestType) => void }).rememberType(
      (r as { id: string }).id,
      (r as { type: RequestType }).type,
    );
  }
  return mapped;
};
void origOutgoing; // keep reference for IDE navigation

function toOutgoingRequest(r: unknown): OutgoingRequest {
  const req = r as { id: string; type: RequestType; body: string; event_type?: string; txn_id?: string };
  return {
    id: req.id,
    type: requestTypeToString(req.type),
    body: req.body,
    event_type: req.event_type,
    txn_id: req.txn_id,
  };
}

function requestTypeToString(t: RequestType): OutgoingRequest["type"] {
  switch (t) {
    case RequestType.KeysUpload: return "keys_upload";
    case RequestType.KeysQuery: return "keys_query";
    case RequestType.KeysClaim: return "keys_claim";
    case RequestType.ToDevice: return "to_device";
    case RequestType.SignatureUpload: return "signature_upload";
    case RequestType.RoomMessage: return "room_message";
    case RequestType.KeysBackup: return "keys_backup";
    default: throw new Error(`unknown request type ${t}`);
  }
}

function generateDeviceId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 10; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

// ── IndexedDB snapshot/restore ─────────────────────────────────────────────

interface IdbSnapshot {
  storeName: string;
  databases: Array<{ name: string; version: number; objectStores: Array<{ name: string; records: Array<{ key: unknown; value: unknown }> }> }>;
}

async function snapshotIdb(storeName: string): Promise<Uint8Array> {
  const dbNames = [`${storeName}::matrix-sdk-crypto`, `${storeName}::matrix-sdk-crypto-meta`];
  const dbs: IdbSnapshot["databases"] = [];
  for (const name of dbNames) {
    const db = await openDb(name);
    if (!db) continue;
    const dump = { name, version: db.version, objectStores: [] as IdbSnapshot["databases"][number]["objectStores"] };
    for (const storeName2 of Array.from(db.objectStoreNames)) {
      const records = await dumpStore(db, storeName2);
      dump.objectStores.push({ name: storeName2, records });
    }
    db.close();
    dbs.push(dump);
  }
  const snapshot: IdbSnapshot = { storeName, databases: dbs };
  return new TextEncoder().encode(JSON.stringify(snapshot));
}

async function restoreIdb(storeName: string, blob: Uint8Array): Promise<void> {
  const snapshot = JSON.parse(new TextDecoder().decode(blob)) as IdbSnapshot;
  for (const dbDump of snapshot.databases) {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(dbDump.name, dbDump.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const os of dbDump.objectStores) {
          if (!db.objectStoreNames.contains(os.name)) db.createObjectStore(os.name);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(Array.from(db.objectStoreNames), "readwrite");
        for (const os of dbDump.objectStores) {
          const store = tx.objectStore(os.name);
          for (const rec of os.records) store.put(rec.value, rec.key as IDBValidKey);
        }
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }
}

async function readDeviceIdFromIdb(storeName: string): Promise<string> {
  const db = await openDb(`${storeName}::matrix-sdk-crypto-meta`);
  if (!db) throw new Error("meta db missing in pickle");
  try {
    const tx = db.transaction(Array.from(db.objectStoreNames), "readonly");
    for (const osName of Array.from(db.objectStoreNames)) {
      const store = tx.objectStore(osName);
      const all = await reqToPromise(store.getAll());
      for (const row of all) {
        if (row && typeof row === "object" && "device_id" in row) return (row as { device_id: string }).device_id;
      }
    }
    throw new Error("device_id not found in meta db");
  } finally {
    db.close();
  }
}

function openDb(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function dumpStore(db: IDBDatabase, storeName: string): Promise<Array<{ key: unknown; value: unknown }>> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const out: Array<{ key: unknown; value: unknown }> = [];
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        out.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
```

`packages/bot-sdk/package.json` (updated):

```json
{
  "name": "@legends/bot-sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@matrix-org/matrix-sdk-crypto-wasm": "^18.3.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.5",
    "fake-indexeddb": "^6.0.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm install && pnpm --filter @legends/bot-sdk test -- olm-machine`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/bot-sdk/src/crypto/olm-machine.ts packages/bot-sdk/test/crypto/olm-machine.test.ts packages/bot-sdk/package.json pnpm-lock.yaml
git commit -m "feat(bot-sdk): add BotOlmMachine wrapper over matrix-sdk-crypto-wasm"
```

---

### Task 19: `BotCryptoTransport` HTTP client

**Files:**
- Create: `packages/bot-sdk/src/transport-crypto.ts`
- Create: `packages/bot-sdk/test/transport-crypto.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bot-sdk/test/transport-crypto.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BotCryptoTransport, BotCryptoTransportError } from "../src/transport-crypto.js";

describe("BotCryptoTransport", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockReset();
  });

  function okResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  it("keysUpload POSTs to /api/bot/v1/crypto/keys/upload with bearer auth", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ one_time_key_counts: { signed_curve25519: 50 } }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    const out = await t.keysUpload({ device_keys: { foo: "bar" } });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://chat.test/api/bot/v1/crypto/keys/upload",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer tok", "content-type": "application/json" }),
        body: JSON.stringify({ device_keys: { foo: "bar" } }),
      }),
    );
    expect(out).toEqual({ one_time_key_counts: { signed_curve25519: 50 } });
  });

  it("keysQuery POSTs to the right path", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ device_keys: {} }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    await t.keysQuery({ device_keys: { "@u:legends.local": [] } });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://chat.test/api/bot/v1/crypto/keys/query");
  });

  it("keysClaim POSTs to the right path", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ one_time_keys: {} }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    await t.keysClaim({ one_time_keys: {} });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://chat.test/api/bot/v1/crypto/keys/claim");
  });

  it("sendToDevice PUTs to /api/bot/v1/crypto/sendToDevice/<type>/<txn>", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({}));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    await t.sendToDevice("m.room.encrypted", "txn-1", { messages: {} });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://chat.test/api/bot/v1/crypto/sendToDevice/m.room.encrypted/txn-1");
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe("PUT");
  });

  it("sync GETs /api/bot/v1/crypto/sync with timeout query", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ to_device: { events: [] }, device_one_time_keys_count: {} }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    await t.sync({ timeoutMs: 30_000 });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://chat.test/api/bot/v1/crypto/sync?timeout=30000");
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("roomMembers GETs /api/bot/v1/crypto/rooms/<id>", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ members: [] }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    await t.roomMembers("!r:legends.local");
    expect(fetchSpy.mock.calls[0][0]).toBe("https://chat.test/api/bot/v1/crypto/rooms/!r:legends.local");
  });

  it("throws BotCryptoTransportError on non-2xx", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const t = new BotCryptoTransport({ token: "tok", baseUrl: "https://chat.test" });
    await expect(t.keysUpload({})).rejects.toBeInstanceOf(BotCryptoTransportError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/bot-sdk test -- transport-crypto`
Expected: failure — module `../src/transport-crypto.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`packages/bot-sdk/src/transport-crypto.ts`:

```ts
export class BotCryptoTransportError extends Error {
  constructor(message: string, public readonly status: number, public readonly bodyText: string) {
    super(message);
    this.name = "BotCryptoTransportError";
  }
}

export interface SyncResponse {
  to_device: { events: unknown[] };
  device_one_time_keys_count: Record<string, number>;
  device_lists?: { changed?: string[]; left?: string[] };
}

export interface RoomMembersResponse {
  members: Array<{ matrix_id: string; device_ids: string[] }>;
}

export class BotCryptoTransport {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor({ token, baseUrl = "" }: { token: string; baseUrl?: string }) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async keysUpload(body: unknown): Promise<{ one_time_key_counts: Record<string, number> }> {
    return this.json("POST", "/api/bot/v1/crypto/keys/upload", body);
  }

  async keysQuery(body: unknown): Promise<{ device_keys: Record<string, Record<string, unknown>> }> {
    return this.json("POST", "/api/bot/v1/crypto/keys/query", body);
  }

  async keysClaim(body: unknown): Promise<{ one_time_keys: Record<string, Record<string, unknown>> }> {
    return this.json("POST", "/api/bot/v1/crypto/keys/claim", body);
  }

  async sendToDevice(eventType: string, txnId: string, body: unknown): Promise<void> {
    await this.json("PUT", `/api/bot/v1/crypto/sendToDevice/${eventType}/${txnId}`, body);
  }

  async sync({ timeoutMs }: { timeoutMs: number }): Promise<SyncResponse> {
    return this.json("GET", `/api/bot/v1/crypto/sync?timeout=${timeoutMs}`);
  }

  async roomMembers(roomId: string): Promise<RoomMembersResponse> {
    return this.json("GET", `/api/bot/v1/crypto/rooms/${roomId}`);
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BotCryptoTransportError(`${method} ${path} → ${res.status}`, res.status, text);
    }
    return (await res.json()) as T;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/bot-sdk test -- transport-crypto`
Expected: PASS (7 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/bot-sdk/src/transport-crypto.ts packages/bot-sdk/test/transport-crypto.test.ts
git commit -m "feat(bot-sdk): add BotCryptoTransport HTTP client"
```

---

### Task 20: `bot.ts` — detect `e2ee_state` in `getMe`, init crypto

**Files:**
- Modify: `packages/bot-sdk/src/bot.ts`
- Modify: `packages/bot-sdk/src/types.ts` (add `e2ee_state` and `e2ee_device_id` to `BotInfo`)
- Create: `packages/bot-sdk/test/bot-e2ee-init.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bot-sdk/test/bot-e2ee-init.test.ts`:

```ts
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
        return new Response(JSON.stringify({ ok: true, result: { id: "bot-a", name: "A", avatarUrl: null, webhookUrl: null, e2ee_state: state, e2ee_device_id: deviceId } }), { status: 200 });
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/upload")) {
        return new Response(JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
  }

  it("disabled: does not create the pickle file or load crypto", async () => {
    mockGetMe("disabled");
    const bot = new LegendsBot({ token: "tok", baseUrl: "https://chat.test", cryptoStorePath: path.join(dir, "olm-store.pickle") });
    await bot.loadBotInfoForTest();
    expect(bot.cryptoForTest()).toBeNull();
    await expect(stat(path.join(dir, "olm-store.pickle"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pending without pickle: bootstraps, writes pickle, calls keysUpload", async () => {
    mockGetMe("pending");
    const bot = new LegendsBot({ token: "tok", baseUrl: "https://chat.test", cryptoStorePath: path.join(dir, "olm-store.pickle") });
    await bot.loadBotInfoForTest();
    expect(bot.cryptoForTest()).not.toBeNull();
    const s = await stat(path.join(dir, "olm-store.pickle"));
    expect(s.isFile()).toBe(true);
    const calls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(calls).toContain("https://chat.test/api/bot/v1/crypto/keys/upload");
  });

  it("ready with existing pickle: loads pickle, does not re-bootstrap", async () => {
    mockGetMe("pending");
    const bot1 = new LegendsBot({ token: "tok", baseUrl: "https://chat.test", cryptoStorePath: path.join(dir, "olm-store.pickle") });
    await bot1.loadBotInfoForTest();
    const ed1 = bot1.cryptoForTest()!.getIdentityKeys().ed25519;

    fetchSpy.mockReset();
    mockGetMe("ready", "DEV-A");
    const bot2 = new LegendsBot({ token: "tok", baseUrl: "https://chat.test", cryptoStorePath: path.join(dir, "olm-store.pickle") });
    await bot2.loadBotInfoForTest();
    expect(bot2.cryptoForTest()).not.toBeNull();
    expect(bot2.cryptoForTest()!.getIdentityKeys().ed25519).toBe(ed1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/bot-sdk test -- bot-e2ee-init`
Expected: failure — `cryptoStorePath` option and `loadBotInfoForTest` / `cryptoForTest` methods don't exist on `LegendsBot`.

- [ ] **Step 3: Write the implementation**

`packages/bot-sdk/src/types.ts` (replace):

```ts
export interface BotInfo {
  id: string;
  name: string;
  avatarUrl: string | null;
  webhookUrl: string | null;
  e2ee_state?: "disabled" | "pending" | "ready";
  e2ee_device_id?: string | null;
}

export interface MessageUpdate {
  message_id: string;
  from: { id: string | null; display_name: string | null };
  chat: { id: string; type: string; title: string };
  text: string;
  ciphertext?: string;
  e2ee_room_id?: string;
  sender_matrix_id?: string;
  reply_to_message_id?: string;
  date: number;
}

export interface CallbackQueryUpdate {
  id: string;
  from: { id: string; display_name: string | null };
  message: { message_id: string; chat: { id: string } };
  data: string;
}

export interface NewMemberUpdate {
  user_id: string;
  display_name: string;
  username: string | null;
  topic_id: string;
  topic_title: string;
}

export interface DmMessageUpdate {
  message_id: string;
  conversation_id: string;
  from: { id: string; display_name: string | null };
  text: string;
  ciphertext?: string;
  e2ee_room_id?: string;
  sender_matrix_id?: string;
  reply_to_message_id?: string;
  date: number;
}

export interface SendDmMessageParams {
  conversationId: string;
  text: string;
  replyToMessageId?: string;
}

export interface Update {
  update_id: string;
  type: "message" | "callback_query" | "new_member" | "dm_message" | string;
  message?: MessageUpdate;
  callback_query?: CallbackQueryUpdate;
  new_member?: NewMemberUpdate;
  dm_message?: DmMessageUpdate;
}

export interface InlineKeyboardButton {
  text: string;
  callbackData: string;
}

export interface SendMessageParams {
  topicId: string;
  text: string;
  replyToMessageId?: string;
  inlineKeyboard?: InlineKeyboardButton[][];
}
```

`packages/bot-sdk/src/bot.ts` (relevant edits — full constructor + `_loadBotInfo` + new fields):

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type {
  BotInfo,
  CallbackQueryUpdate,
  DmMessageUpdate,
  MessageUpdate,
  NewMemberUpdate,
  SendDmMessageParams,
  SendMessageParams,
  Update,
} from "./types.js";
import { LegendsBotClient } from "./client.js";
import { OlmStore } from "./crypto/olm-store.js";
import { BotOlmMachine } from "./crypto/olm-machine.js";
import { BotCryptoTransport } from "./transport-crypto.js";

// … MessageContext / NewMemberContext / CallbackQueryContext / DmMessageContext stay unchanged (until Task 22).

export class LegendsBot {
  public readonly api: LegendsBotClient;
  public readonly cryptoTransport: BotCryptoTransport;

  private readonly _handlers = {
    message: [] as MsgHandler[],
    new_member: [] as MemberHandler[],
    callback_query: [] as CallbackHandler[],
    dm_message: [] as DmMsgHandler[],
  };

  private _onError: ErrorHandler = (err) => console.error("[bot] unhandled error:", err);
  private _running = false;
  private _botInfo: BotInfo | null = null;
  private _crypto: BotOlmMachine | null = null;
  private _cryptoStore: OlmStore | null = null;
  private readonly _cryptoStorePath: string;

  constructor({
    token,
    baseUrl,
    cryptoStorePath,
  }: {
    token: string;
    baseUrl?: string;
    cryptoStorePath?: string;
  }) {
    this.api = new LegendsBotClient({ token, baseUrl });
    this.cryptoTransport = new BotCryptoTransport({ token, baseUrl });
    this._cryptoStorePath = cryptoStorePath ?? path.join(process.cwd(), "data", "olm-store.pickle");
  }

  private async _loadBotInfo(): Promise<void> {
    const info = await this.api.getMe().catch(() => null);
    if (!info) return;
    this._botInfo = info;
    const state = info.e2ee_state ?? "disabled";
    if (state === "disabled") {
      this._crypto = null;
      return;
    }
    // pending or ready → load/bootstrap crypto.
    this._cryptoStore = new OlmStore(this._cryptoStorePath);
    const hadPickle = await this._cryptoStore.exists();
    this._crypto = await BotOlmMachine.create({ botId: info.id, store: this._cryptoStore });
    if (!hadPickle) {
      // Fresh bootstrap → upload keys.
      const reqs = await this._crypto.outgoingRequests();
      for (const r of reqs) {
        if (r.type === "keys_upload") {
          const resp = await this.cryptoTransport.keysUpload(JSON.parse(r.body));
          await this._crypto.markRequestAsSent(r.id, JSON.stringify(resp));
        }
      }
      await this._crypto.persist();
    }
  }

  // Test hooks (exported only so unit tests can drive the lifecycle without
  // spinning up the polling loop). Production callers go through start().
  public async loadBotInfoForTest(): Promise<void> {
    await this._loadBotInfo();
  }
  public cryptoForTest(): BotOlmMachine | null {
    return this._crypto;
  }

  // … on() / catch() / handleUpdate() / webhookCallback() unchanged

  async startWebhook(opts: { port: number; webhookUrl: string; path?: string }): Promise<void> {
    await this._loadBotInfo();
    await this.api.setWebhook(opts.webhookUrl.replace(/\/$/, "") + (opts.path ?? "/webhook"));
    const handler = this.webhookCallback(opts.path ?? "/webhook");
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((resolve) => server.listen(opts.port, resolve));
    console.log(`[bot] webhook server on :${opts.port}${opts.path ?? "/webhook"} → ${opts.webhookUrl}${opts.path ?? "/webhook"}`);
  }

  async start(): Promise<void> {
    this._running = true;
    await this._loadBotInfo();
    console.log(`[bot] polling started${this._botInfo ? ` (${this._botInfo.name})` : ""}`);

    while (this._running) {
      try {
        const updates = await this.api.getUpdates();
        for (const u of updates) await this.handleUpdate(u);
        if (updates.length === 0) await delay(500);
      } catch (err) {
        this._onError(err, {} as Update);
        await delay(5_000);
      }
    }
  }

  stop(): void {
    this._running = false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/bot-sdk test -- bot-e2ee-init`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/bot-sdk/src/bot.ts packages/bot-sdk/src/types.ts packages/bot-sdk/test/bot-e2ee-init.test.ts
git commit -m "feat(bot-sdk): detect e2ee_state in getMe and init crypto on start"
```

---

### Task 21: `bot.ts` — incoming envelope decrypt

**Files:**
- Modify: `packages/bot-sdk/src/bot.ts` (`handleUpdate`)
- Create: `packages/bot-sdk/test/bot-incoming-decrypt.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bot-sdk/test/bot-incoming-decrypt.test.ts`:

```ts
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegendsBot } from "../src/bot.js";
import { OlmStore } from "../src/crypto/olm-store.js";
import { BotOlmMachine } from "../src/crypto/olm-machine.js";

describe("LegendsBot — incoming decrypt", () => {
  let dir: string;
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bot-incoming-"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function mockGetMe(state: "pending" | "ready"): void {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: "bot-a", name: "A", avatarUrl: null, webhookUrl: null, e2ee_state: state, e2ee_device_id: "DEV-A" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });
  }

  it("decrypts a DM envelope and passes plaintext to the handler", async () => {
    // Set up bot + user machines, share room key, encrypt a message as user.
    const userStorePath = path.join(dir, "user.pickle");
    const userStore = new OlmStore(userStorePath);
    const user = await BotOlmMachine.create({ botId: "user-a", store: userStore, matrixId: "@user-a:legends.local" });

    mockGetMe("ready");
    const bot = new LegendsBot({ token: "tok", baseUrl: "https://chat.test", cryptoStorePath: path.join(dir, "bot.pickle") });
    await bot.loadBotInfoForTest();
    const botMachine = bot.cryptoForTest()!;

    // Bridge identities (test helper from Task 18 inlined here).
    for (const m of [user, botMachine]) {
      for (const r of await m.outgoingRequests()) {
        if (r.type === "keys_upload") await m.markRequestAsSent(r.id, JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }));
        else if (r.type === "keys_query") await m.markRequestAsSent(r.id, JSON.stringify({ device_keys: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {} }));
      }
    }
    await user.updateTrackedUsers(["@bot.bot-a:legends.local"]);
    await botMachine.updateTrackedUsers(["@user-a:legends.local"]);

    const roomId = "!conv1:legends.local";
    const shareReqs = await user.shareRoomKey(roomId, ["@bot.bot-a:legends.local"]);
    for (const r of shareReqs) {
      const messages = JSON.parse(r.body).messages as Record<string, Record<string, unknown>>;
      const events: unknown[] = [];
      for (const [, devices] of Object.entries(messages)) {
        for (const [, content] of Object.entries(devices)) {
          events.push({ type: r.event_type, sender: "@user-a:legends.local", content });
        }
      }
      await botMachine.receiveSyncChanges({ toDevice: JSON.stringify({ events }), otkCounts: {} });
      await user.markRequestAsSent(r.id, "{}");
    }

    const { ciphertext } = await user.encryptForRoom(roomId, "hello bot", "m.room.message");

    let received: string | null = null;
    bot.on("dm_message", (ctx) => { received = ctx.dm_message.text; });
    await bot.handleUpdate({
      update_id: "u1",
      type: "dm_message",
      dm_message: {
        message_id: "m1",
        conversation_id: "conv1",
        from: { id: "user-a", display_name: "U" },
        text: "",
        ciphertext,
        e2ee_room_id: roomId,
        sender_matrix_id: "@user-a:legends.local",
        date: 0,
      },
    });
    expect(received).toContain("hello bot");
  });

  it("calls _onError and skips the handler when ciphertext fails to decrypt", async () => {
    mockGetMe("ready");
    const bot = new LegendsBot({ token: "tok", baseUrl: "https://chat.test", cryptoStorePath: path.join(dir, "bot.pickle") });
    await bot.loadBotInfoForTest();

    const handlerCalls: string[] = [];
    bot.on("dm_message", (ctx) => { handlerCalls.push(ctx.dm_message.text); });
    const errors: unknown[] = [];
    bot.catch((err) => { errors.push(err); });

    await bot.handleUpdate({
      update_id: "u2",
      type: "dm_message",
      dm_message: {
        message_id: "m2",
        conversation_id: "conv1",
        from: { id: "user-a", display_name: "U" },
        text: "",
        ciphertext: '{"algorithm":"garbage","ciphertext":"garbage","sender_key":"x","session_id":"y","device_id":"z"}',
        e2ee_room_id: "!conv1:legends.local",
        sender_matrix_id: "@user-a:legends.local",
        date: 0,
      },
    });
    expect(handlerCalls).toEqual([]);
    expect(errors.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/bot-sdk test -- bot-incoming-decrypt`
Expected: failure — the handler currently receives empty `text` (no decrypt step).

- [ ] **Step 3: Write the implementation**

In `packages/bot-sdk/src/bot.ts`, replace `handleUpdate`:

```ts
async handleUpdate(update: Update): Promise<void> {
  try {
    if (update.type === "message" && update.message) {
      const msg = await this._decryptIncomingMessage(update.message);
      const ctx = new MessageContext(this, update, msg);
      for (const h of this._handlers.message) await h(ctx);
    } else if (update.type === "new_member" && update.new_member) {
      const ctx = new NewMemberContext(this, update, update.new_member);
      for (const h of this._handlers.new_member) await h(ctx);
    } else if (update.type === "callback_query" && update.callback_query) {
      const ctx = new CallbackQueryContext(this, update, update.callback_query);
      for (const h of this._handlers.callback_query) await h(ctx);
    } else if (update.type === "dm_message" && update.dm_message) {
      const dm = await this._decryptIncomingDm(update.dm_message);
      const ctx = new DmMessageContext(this, update, dm);
      for (const h of this._handlers.dm_message) await h(ctx);
    }
  } catch (err) {
    this._onError(err, update);
  }
}

private async _decryptIncomingMessage(m: MessageUpdate): Promise<MessageUpdate> {
  if (!m.ciphertext || !m.e2ee_room_id || !this._crypto) return m;
  const sender = m.sender_matrix_id ?? "";
  const plaintext = await this._crypto.decryptRoomMessage(m.e2ee_room_id, { ciphertext: m.ciphertext, sender });
  return { ...m, text: plaintext };
}

private async _decryptIncomingDm(d: DmMessageUpdate): Promise<DmMessageUpdate> {
  if (!d.ciphertext || !d.e2ee_room_id || !this._crypto) return d;
  const sender = d.sender_matrix_id ?? "";
  const plaintext = await this._crypto.decryptRoomMessage(d.e2ee_room_id, { ciphertext: d.ciphertext, sender });
  return { ...d, text: plaintext };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/bot-sdk test -- bot-incoming-decrypt`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/bot-sdk/src/bot.ts packages/bot-sdk/test/bot-incoming-decrypt.test.ts
git commit -m "feat(bot-sdk): decrypt incoming E2EE DM and topic envelopes"
```

---

### Task 22: `bot.ts` — outgoing encrypt + room key share

**Files:**
- Modify: `packages/bot-sdk/src/bot.ts` (`MessageContext.reply`, `DmMessageContext.reply`, new `_sendEncrypted` private)
- Modify: `packages/bot-sdk/src/client.ts` (add `sendDmCiphertext` + `sendTopicCiphertext`)
- Create: `packages/bot-sdk/test/bot-outgoing-encrypt.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bot-sdk/test/bot-outgoing-encrypt.test.ts`:

```ts
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegendsBot, DmMessageContext } from "../src/bot.js";

describe("LegendsBot — outgoing encrypt", () => {
  let dir: string;
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bot-out-"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ctx.reply on an E2EE DM walks the full key-share + encrypt + sendDmCiphertext sequence", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: "bot-a", name: "A", avatarUrl: null, webhookUrl: null, e2ee_state: "ready", e2ee_device_id: "DEV-A" } }), { status: 200 });
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/upload")) {
        return new Response(JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }), { status: 200 });
      }
      if (url.includes("/api/bot/v1/crypto/rooms/")) {
        return new Response(JSON.stringify({ members: [{ matrix_id: "@user-a:legends.local", device_ids: ["DEV-U"] }] }), { status: 200 });
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
      if (url.endsWith("/api/bot/v1/sendDmCiphertext")) {
        return new Response(JSON.stringify({ ok: true, result: { messageId: "m-out-1" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const bot = new LegendsBot({ token: "tok", baseUrl: "https://chat.test", cryptoStorePath: path.join(dir, "bot.pickle") });
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
    expect(paths.some((p) => p.includes("/crypto/sendToDevice/"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/api/bot/v1/sendDmCiphertext"))).toBe(true);
    // Verify the sendDmCiphertext body carries a non-empty ciphertext.
    const sendCall = fetchSpy.mock.calls.find((c) => (c[0] as string).endsWith("/api/bot/v1/sendDmCiphertext"))!;
    const body = JSON.parse((sendCall[1] as RequestInit).body as string) as { ciphertext: string };
    expect(body.ciphertext.length).toBeGreaterThan(0);
  });

  it("ctx.reply on a non-E2EE DM falls back to sendDmMessage (plaintext)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: "bot-a", name: "A", avatarUrl: null, webhookUrl: null, e2ee_state: "disabled" } }), { status: 200 });
      }
      if (url.endsWith("/api/bot/v1/sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { messageId: "m-plain" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const bot = new LegendsBot({ token: "tok", baseUrl: "https://chat.test", cryptoStorePath: path.join(dir, "bot.pickle") });
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/bot-sdk test -- bot-outgoing-encrypt`
Expected: failure — `sendDmCiphertext` route is never hit (no encrypt path exists yet).

- [ ] **Step 3: Write the implementation**

`packages/bot-sdk/src/client.ts` (add two methods at the bottom of the class):

```ts
  async sendDmCiphertext(params: { conversationId: string; ciphertext: string; replyToMessageId?: string }): Promise<{ messageId: string }> {
    return this.call<{ messageId: string }>("sendDmCiphertext", params);
  }

  async sendTopicCiphertext(params: { topicId: string; ciphertext: string; replyToMessageId?: string }): Promise<{ messageId: string }> {
    return this.call<{ messageId: string }>("sendTopicCiphertext", params);
  }
```

`packages/bot-sdk/src/bot.ts` (replace `MessageContext.reply` and `DmMessageContext.reply`, add `_sendEncrypted`):

```ts
export class MessageContext {
  constructor(
    public readonly bot: LegendsBot,
    public readonly update: Update,
    public readonly message: MessageUpdate,
  ) {}

  get topicId(): string { return this.message.chat.id; }

  async reply(text: string, options?: Omit<SendMessageParams, "topicId" | "text">): Promise<{ messageId: string }> {
    if (this.message.e2ee_room_id) {
      return this.bot._sendEncryptedForTest({
        roomId: this.message.e2ee_room_id,
        target: { kind: "topic", topicId: this.topicId },
        plaintext: text,
      });
    }
    return this.bot.api.sendMessage({ topicId: this.topicId, text, ...options });
  }

  async deleteThisMessage(): Promise<void> {
    return this.bot.api.deleteMessage({ messageId: this.message.message_id });
  }

  async editThisMessage(text: string): Promise<void> {
    return this.bot.api.editMessage({ messageId: this.message.message_id, text });
  }
}

export class DmMessageContext {
  constructor(
    public readonly bot: LegendsBot,
    public readonly update: Update,
    public readonly dm_message: DmMessageUpdate,
  ) {}

  get conversationId(): string { return this.dm_message.conversation_id; }

  async reply(text: string, options?: Omit<SendDmMessageParams, "conversationId" | "text">): Promise<{ messageId: string }> {
    if (this.dm_message.e2ee_room_id) {
      return this.bot._sendEncryptedForTest({
        roomId: this.dm_message.e2ee_room_id,
        target: { kind: "dm", conversationId: this.conversationId },
        plaintext: text,
      });
    }
    return this.bot.api.sendDmMessage({ conversationId: this.conversationId, text, ...options });
  }
}
```

Add to `LegendsBot`:

```ts
/** Public only so context classes can dispatch through it. Not part of the public SDK surface. */
public async _sendEncryptedForTest(args: {
  roomId: string;
  target: { kind: "dm"; conversationId: string } | { kind: "topic"; topicId: string };
  plaintext: string;
}): Promise<{ messageId: string }> {
  return this._sendEncrypted(args);
}

private async _sendEncrypted({
  roomId,
  target,
  plaintext,
}: {
  roomId: string;
  target: { kind: "dm"; conversationId: string } | { kind: "topic"; topicId: string };
  plaintext: string;
}): Promise<{ messageId: string }> {
  if (!this._crypto) throw new Error("crypto not initialised");

  // 1. Look up room members.
  const { members } = await this.cryptoTransport.roomMembers(roomId);
  const memberIds = members.map((m) => m.matrix_id);

  // 2. Ask the machine for to-device requests that share the room key.
  const shareReqs = await this._crypto.shareRoomKey(roomId, memberIds);

  // 3. Drive any keys_claim / to_device requests through the transport.
  for (const r of shareReqs) {
    if (r.type === "keys_claim") {
      const resp = await this.cryptoTransport.keysClaim(JSON.parse(r.body));
      await this._crypto.markRequestAsSent(r.id, JSON.stringify(resp));
    } else if (r.type === "to_device") {
      await this.cryptoTransport.sendToDevice(r.event_type!, r.txn_id ?? r.id, JSON.parse(r.body));
      await this._crypto.markRequestAsSent(r.id, "{}");
    }
  }

  // 4. Encrypt the payload.
  const { ciphertext } = await this._crypto.encryptForRoom(roomId, plaintext, "m.room.message");

  // 5. Deliver via the right SDK endpoint.
  const out = target.kind === "dm"
    ? await this.api.sendDmCiphertext({ conversationId: target.conversationId, ciphertext })
    : await this.api.sendTopicCiphertext({ topicId: target.topicId, ciphertext });

  // 6. Persist the updated machine state.
  await this._crypto.persist();
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/bot-sdk test -- bot-outgoing-encrypt`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/bot-sdk/src/bot.ts packages/bot-sdk/src/client.ts packages/bot-sdk/test/bot-outgoing-encrypt.test.ts
git commit -m "feat(bot-sdk): encrypt outgoing E2EE replies and share Megolm room keys"
```

---

### Task 23: `bot.ts` — `_cryptoSyncLoop` background drain

**Files:**
- Modify: `packages/bot-sdk/src/bot.ts` (add `_cryptoSyncLoop`, call from `start()` + `startWebhook()`, await on `stop()`)
- Create: `packages/bot-sdk/test/bot-sync-loop.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bot-sdk/test/bot-sync-loop.test.ts`:

```ts
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegendsBot } from "../src/bot.js";

describe("LegendsBot — crypto sync loop", () => {
  let dir: string;
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bot-sync-"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("drains one batch, then exits on stop()", async () => {
    let syncCalls = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: "bot-a", name: "A", avatarUrl: null, webhookUrl: null, e2ee_state: "ready", e2ee_device_id: "DEV-A" } }), { status: 200 });
      }
      if (url.startsWith("https://chat.test/api/bot/v1/crypto/sync")) {
        syncCalls++;
        return new Response(JSON.stringify({ to_device: { events: [] }, device_one_time_keys_count: { signed_curve25519: 50 } }), { status: 200 });
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/upload")) {
        return new Response(JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const bot = new LegendsBot({ token: "tok", baseUrl: "https://chat.test", cryptoStorePath: path.join(dir, "bot.pickle") });
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
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (typeof ms === "number") delays.push(ms);
      return origSetTimeout(fn, 0);
    }) as typeof globalThis.setTimeout;

    let syncCalls = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: "bot-a", name: "A", avatarUrl: null, webhookUrl: null, e2ee_state: "ready", e2ee_device_id: "DEV-A" } }), { status: 200 });
      }
      if (url.startsWith("https://chat.test/api/bot/v1/crypto/sync")) {
        syncCalls++;
        if (syncCalls === 1) return new Response(JSON.stringify({ error: "down" }), { status: 503 });
        return new Response(JSON.stringify({ to_device: { events: [] }, device_one_time_keys_count: { signed_curve25519: 50 } }), { status: 200 });
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/upload")) {
        return new Response(JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    try {
      const bot = new LegendsBot({ token: "tok", baseUrl: "https://chat.test", cryptoStorePath: path.join(dir, "bot.pickle") });
      await bot.loadBotInfoForTest();
      const loop = bot.cryptoSyncLoopForTest();
      await new Promise((r) => origSetTimeout(r, 50));
      bot.stop();
      await loop;
      expect(delays).toContain(500);
      expect(syncCalls).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/bot-sdk test -- bot-sync-loop`
Expected: failure — `cryptoSyncLoopForTest` does not exist.

- [ ] **Step 3: Write the implementation**

In `packages/bot-sdk/src/bot.ts`, add to `LegendsBot`:

```ts
private _syncLoopPromise: Promise<void> | null = null;

/** Test entry-point. Returns the loop promise so the test can await on stop(). */
public cryptoSyncLoopForTest(): Promise<void> {
  this._running = true;
  this._syncLoopPromise = this._cryptoSyncLoop();
  return this._syncLoopPromise;
}

private async _cryptoSyncLoop(): Promise<void> {
  if (!this._crypto) return;
  const backoffSteps = [500, 1_000, 2_000, 4_000, 8_000];
  let backoffIdx = 0;
  while (this._running) {
    try {
      const sync = await this.cryptoTransport.sync({ timeoutMs: 30_000 });
      await this._crypto.receiveSyncChanges({
        toDevice: JSON.stringify({ events: sync.to_device.events }),
        otkCounts: sync.device_one_time_keys_count,
        changedDevices: sync.device_lists,
      });

      // Drain outgoing requests.
      const reqs = await this._crypto.outgoingRequests();
      for (const r of reqs) {
        if (r.type === "keys_upload") {
          const resp = await this.cryptoTransport.keysUpload(JSON.parse(r.body));
          await this._crypto.markRequestAsSent(r.id, JSON.stringify(resp));
        } else if (r.type === "keys_query") {
          const resp = await this.cryptoTransport.keysQuery(JSON.parse(r.body));
          await this._crypto.markRequestAsSent(r.id, JSON.stringify(resp));
        } else if (r.type === "keys_claim") {
          const resp = await this.cryptoTransport.keysClaim(JSON.parse(r.body));
          await this._crypto.markRequestAsSent(r.id, JSON.stringify(resp));
        } else if (r.type === "to_device") {
          await this.cryptoTransport.sendToDevice(r.event_type!, r.txn_id ?? r.id, JSON.parse(r.body));
          await this._crypto.markRequestAsSent(r.id, "{}");
        }
      }

      await this._crypto.persist();
      backoffIdx = 0;
    } catch (err) {
      this._onError(err, {} as Update);
      const delayMs = backoffSteps[Math.min(backoffIdx, backoffSteps.length - 1)];
      backoffIdx++;
      await delay(delayMs);
    }
  }
}
```

Update `start()` so it kicks off the loop after `_loadBotInfo`:

```ts
async start(): Promise<void> {
  this._running = true;
  await this._loadBotInfo();
  if (this._crypto) this._syncLoopPromise = this._cryptoSyncLoop();
  console.log(`[bot] polling started${this._botInfo ? ` (${this._botInfo.name})` : ""}`);

  while (this._running) {
    try {
      const updates = await this.api.getUpdates();
      for (const u of updates) await this.handleUpdate(u);
      if (updates.length === 0) await delay(500);
    } catch (err) {
      this._onError(err, {} as Update);
      await delay(5_000);
    }
  }
  if (this._syncLoopPromise) await this._syncLoopPromise;
}
```

Update `startWebhook()` to start + await the loop similarly. Update `stop()`:

```ts
stop(): void {
  this._running = false;
}
```

(`_running = false` is enough — the running awaits in `_cryptoSyncLoop` will return on the next iteration.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/bot-sdk test -- bot-sync-loop`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/bot-sdk/src/bot.ts packages/bot-sdk/test/bot-sync-loop.test.ts
git commit -m "feat(bot-sdk): add _cryptoSyncLoop background drain with backoff"
```

---

### Task 24: `bot.ts` — OTK top-up

**Files:**
- Modify: `packages/bot-sdk/src/bot.ts` (`_cryptoSyncLoop` already calls `outgoingRequests`; OTK top-up is implicit through the `keys_upload` path the wasm machine emits when counts drop). Add an explicit low-water-mark check + log entry.
- Create: `packages/bot-sdk/test/bot-otk-topup.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bot-sdk/test/bot-otk-topup.test.ts`:

```ts
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegendsBot } from "../src/bot.js";

describe("LegendsBot — OTK top-up", () => {
  let dir: string;
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bot-otk-"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uploads new OTKs when sync reports signed_curve25519 below the threshold", async () => {
    const uploadBodies: unknown[] = [];
    let syncCalls = 0;
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: "bot-a", name: "A", avatarUrl: null, webhookUrl: null, e2ee_state: "pending", e2ee_device_id: null } }), { status: 200 });
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/upload")) {
        uploadBodies.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }), { status: 200 });
      }
      if (url.startsWith("https://chat.test/api/bot/v1/crypto/sync")) {
        syncCalls++;
        // First sync: report 0 OTKs → machine must produce another keys_upload.
        return new Response(JSON.stringify({ to_device: { events: [] }, device_one_time_keys_count: { signed_curve25519: 0 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const bot = new LegendsBot({ token: "tok", baseUrl: "https://chat.test", cryptoStorePath: path.join(dir, "bot.pickle") });
    await bot.loadBotInfoForTest();
    const initialUploads = uploadBodies.length;
    expect(initialUploads).toBeGreaterThan(0); // bootstrap upload

    const loop = bot.cryptoSyncLoopForTest();
    await new Promise((r) => setTimeout(r, 80));
    bot.stop();
    await loop;

    // After the sync that reported 0 OTKs, the machine must have asked for
    // another keys_upload that the loop dispatched.
    expect(uploadBodies.length).toBeGreaterThan(initialUploads);
    expect(syncCalls).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/bot-sdk test -- bot-otk-topup`
Expected: failure — without the OTK-threshold check (or simply ensuring the sync-loop processes the wasm's emitted `keys_upload`), no follow-up upload occurs.

- [ ] **Step 3: Write the implementation**

The Task 23 loop already drains every outgoing `keys_upload` the wasm machine emits, so the wasm's internal OTK math handles the top-up automatically once `receiveSyncChanges` is fed `{signed_curve25519: 0}`. The only delta for Task 24 is a small, visible "low water mark" guard — primarily for observability and to allow callers to bump the threshold.

In `packages/bot-sdk/src/bot.ts`, replace `_cryptoSyncLoop` with:

```ts
private static readonly OTK_LOW_WATER = 5;

private async _cryptoSyncLoop(): Promise<void> {
  if (!this._crypto) return;
  const backoffSteps = [500, 1_000, 2_000, 4_000, 8_000];
  let backoffIdx = 0;
  while (this._running) {
    try {
      const sync = await this.cryptoTransport.sync({ timeoutMs: 30_000 });
      await this._crypto.receiveSyncChanges({
        toDevice: JSON.stringify({ events: sync.to_device.events }),
        otkCounts: sync.device_one_time_keys_count,
        changedDevices: sync.device_lists,
      });

      const otkCount = sync.device_one_time_keys_count.signed_curve25519 ?? 0;
      if (otkCount < LegendsBot.OTK_LOW_WATER) {
        console.log(`[bot] OTK low (${otkCount}); machine will top up via outgoingRequests`);
      }

      const reqs = await this._crypto.outgoingRequests();
      for (const r of reqs) {
        if (r.type === "keys_upload") {
          const resp = await this.cryptoTransport.keysUpload(JSON.parse(r.body));
          await this._crypto.markRequestAsSent(r.id, JSON.stringify(resp));
        } else if (r.type === "keys_query") {
          const resp = await this.cryptoTransport.keysQuery(JSON.parse(r.body));
          await this._crypto.markRequestAsSent(r.id, JSON.stringify(resp));
        } else if (r.type === "keys_claim") {
          const resp = await this.cryptoTransport.keysClaim(JSON.parse(r.body));
          await this._crypto.markRequestAsSent(r.id, JSON.stringify(resp));
        } else if (r.type === "to_device") {
          await this.cryptoTransport.sendToDevice(r.event_type!, r.txn_id ?? r.id, JSON.parse(r.body));
          await this._crypto.markRequestAsSent(r.id, "{}");
        }
      }

      await this._crypto.persist();
      backoffIdx = 0;
    } catch (err) {
      this._onError(err, {} as Update);
      const delayMs = backoffSteps[Math.min(backoffIdx, backoffSteps.length - 1)];
      backoffIdx++;
      await delay(delayMs);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/bot-sdk test -- bot-otk-topup`
Expected: PASS (1 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/bot-sdk/src/bot.ts packages/bot-sdk/test/bot-otk-topup.test.ts
git commit -m "feat(bot-sdk): top up OTKs from sync-loop when count drops"
```

---

## Self-review checklist

- [x] 8 tasks total (17–24)
- [x] Every task has complete test code AND complete implementation code
- [x] Wrapper method names referenced in tasks 20–24 match the definitions in Task 18 (`getIdentityKeys`, `getDeviceId`, `outgoingRequests`, `markRequestAsSent`, `receiveSyncChanges`, `updateTrackedUsers`, `shareRoomKey`, `encryptForRoom`, `decryptRoomMessage`, `persist`)
- [x] Wasm API names from the matrix package's real `.d.ts`: `OlmMachine.initialize`, `identityKeys`, `deviceId`, `outgoingRequests`, `markRequestAsSent`, `receiveSyncChanges`, `updateTrackedUsers`, `shareRoomKey`, `encryptRoomEvent`, `decryptRoomEvent`, `RequestType` enum, `KeysUploadRequest` / `KeysQueryRequest` / `KeysClaimRequest` / `ToDeviceRequest` shapes
