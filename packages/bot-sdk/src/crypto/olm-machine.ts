/**
 * Thin wrapper around `@matrix-org/matrix-sdk-crypto-wasm`'s `OlmMachine` so
 * that the rest of the bot SDK can deal with a small, stable surface area and
 * the snapshot/restore lifecycle is kept in one place.
 *
 * Persistence strategy (see plan INDEX R3):
 *   matrix-sdk-crypto-wasm v18.3.0 stores its state in IndexedDB. In Node we
 *   back IndexedDB with `fake-indexeddb` (the package consumer imports
 *   `fake-indexeddb/auto`). To get a portable "pickle" file on disk we dump
 *   every record from every object store into a JSON envelope and write that
 *   via {@link OlmStore}. On restore we re-create the databases / stores and
 *   re-insert the records before `OlmMachine.initialize` re-opens them.
 *
 * The wasm `OlmMachine.initialize` ctor signature is the real one:
 *   `static initialize(user_id, device_id, store_name?, store_passphrase?, ...)`
 * so as long as we restore IDB to the exact state observed at snapshot time
 * and pass the same `store_name` + `store_passphrase` + `device_id`, the
 * machine resumes the same Olm identity, prekeys, megolm sessions, etc.
 */

import {
  OlmMachine,
  UserId,
  DeviceId,
  RoomId,
  DeviceLists,
  EncryptionSettings,
  DecryptionSettings,
  RequestType,
  TrustRequirement,
} from "@matrix-org/matrix-sdk-crypto-wasm";
import type { OlmStore } from "./olm-store.js";

/**
 * Stable string representation of the wasm `RequestType` enum, exposed to
 * callers so they don't have to import wasm types.
 */
export type OutgoingRequestType =
  | "keys_upload"
  | "keys_query"
  | "keys_claim"
  | "to_device"
  | "signature_upload"
  | "room_message"
  | "keys_backup";

export interface OutgoingRequest {
  id: string;
  type: OutgoingRequestType;
  body: string;
  /** Only set for `to_device` requests. */
  event_type?: string;
  /** Only set for `to_device` requests. */
  txn_id?: string;
}

export interface IdentityKeyPair {
  ed25519: string;
  curve25519: string;
}

export interface SyncChangesInput {
  /** JSON-encoded array of to-device events from the `/sync` response. */
  toDevice: string;
  /** OTK counts from the `/sync` response (e.g. `{ signed_curve25519: 50 }`). */
  otkCounts: Record<string, number>;
}

export interface BotOlmMachineCreateOpts {
  /** Stable identifier for this principal. Bots use their UUID, tests can use any string. */
  botId: string;
  /** FS-backed snapshot store. */
  store: OlmStore;
  /**
   * Override the auto-generated Matrix user id. Bots get `@bot.<botId>:legends.local`;
   * tests use this to simulate a regular user peer.
   */
  matrixId?: string;
}

interface SnapshotEnvelope {
  /** Snapshot format version — bumped if the on-disk shape changes. */
  v: 1;
  /** Stable per-instance store name used as the IndexedDB database name prefix. */
  storeName: string;
  /** The wasm's device id, kept in plaintext so we can pass it back to `initialize`. */
  deviceId: string;
  /** The Matrix user id this machine belongs to. */
  matrixId: string;
  /** Passphrase used to encrypt the IDB store (kept alongside the snapshot — same trust as the FS). */
  passphrase: string;
  /** Every IDB database backing this machine. */
  databases: SnapshotDatabase[];
}

interface SnapshotDatabase {
  name: string;
  version: number;
  objectStores: SnapshotObjectStore[];
}

interface SnapshotObjectStore {
  name: string;
  records: SnapshotRecord[];
}

interface SnapshotRecord {
  key: SnapshotValue;
  value: SnapshotValue;
}

/** Tagged JSON value so we can round-trip Uint8Array entries safely. */
type SnapshotValue =
  | { t: "json"; v: unknown }
  | { t: "bytes"; v: string /* base64 */ };

const PASSPHRASE_PREFIX = "legends-bot-v1::";
const MATRIX_DOMAIN = "legends.local";

export class BotOlmMachine {
  private readonly pendingTypes = new Map<string, RequestType>();

  private constructor(
    private readonly machine: OlmMachine,
    private readonly store: OlmStore,
    private readonly storeName: string,
    private readonly passphrase: string,
    private readonly matrixId: string,
    private readonly deviceId: string,
  ) {}

  static async create(opts: BotOlmMachineCreateOpts): Promise<BotOlmMachine> {
    const { botId, store } = opts;
    const matrixId = opts.matrixId ?? `@bot.${botId}:${MATRIX_DOMAIN}`;

    const existing = await store.load();
    if (existing) {
      const snapshot = decodeSnapshot(existing);
      await restoreIdb(snapshot.databases);
      const machine = await OlmMachine.initialize(
        new UserId(snapshot.matrixId),
        new DeviceId(snapshot.deviceId),
        snapshot.storeName,
        snapshot.passphrase,
      );
      return new BotOlmMachine(
        machine,
        store,
        snapshot.storeName,
        snapshot.passphrase,
        snapshot.matrixId,
        snapshot.deviceId,
      );
    }

    // Fresh bootstrap. The store name embeds `botId` plus a random suffix so
    // that simultaneously running tests / machines don't collide on the
    // shared `fake-indexeddb` global.
    const storeName = `legends-bot-${botId}-${randomSuffix()}`;
    const passphrase = `${PASSPHRASE_PREFIX}${randomSuffix()}`;
    const deviceId = generateDeviceId();
    const machine = await OlmMachine.initialize(
      new UserId(matrixId),
      new DeviceId(deviceId),
      storeName,
      passphrase,
    );
    const wrapper = new BotOlmMachine(machine, store, storeName, passphrase, matrixId, deviceId);
    await wrapper.persist();
    return wrapper;
  }

  getIdentityKeys(): IdentityKeyPair {
    const keys = this.machine.identityKeys;
    return {
      ed25519: keys.ed25519.toBase64(),
      curve25519: keys.curve25519.toBase64(),
    };
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getMatrixId(): string {
    return this.matrixId;
  }

  async outgoingRequests(): Promise<OutgoingRequest[]> {
    const raw = await this.machine.outgoingRequests();
    const out: OutgoingRequest[] = [];
    for (const r of raw) {
      const req = r as {
        id: string;
        type: RequestType;
        body: string;
        event_type?: string;
        txn_id?: string;
      };
      this.pendingTypes.set(req.id, req.type);
      out.push({
        id: req.id,
        type: requestTypeToString(req.type),
        body: req.body,
        event_type: req.event_type,
        txn_id: req.txn_id,
      });
    }
    return out;
  }

  /**
   * Mark a previously-surfaced outgoing request as delivered. The wasm needs
   * the `RequestType` enum value plus the JSON-encoded server response.
   *
   * Callers don't pass the type — we remember it from {@link outgoingRequests}
   * so the wrapper API stays consistent with the rest of the bot SDK.
   */
  async markRequestAsSent(requestId: string, responseBody: string): Promise<void> {
    const type = this.pendingTypes.get(requestId);
    if (type === undefined) {
      throw new Error(
        `BotOlmMachine.markRequestAsSent: unknown request id ${requestId} — call outgoingRequests() first`,
      );
    }
    await this.machine.markRequestAsSent(requestId, type, responseBody);
    this.pendingTypes.delete(requestId);
  }

  async receiveSyncChanges(input: SyncChangesInput): Promise<void> {
    const counts = new Map<string, number>(Object.entries(input.otkCounts));
    await this.machine.receiveSyncChanges(input.toDevice, new DeviceLists(), counts);
  }

  async updateTrackedUsers(matrixIds: string[]): Promise<void> {
    await this.machine.updateTrackedUsers(matrixIds.map((id) => new UserId(id)));
  }

  /**
   * Returns the to-device requests needed to share the room key with the given
   * member set. The wrapper does NOT internally claim missing Olm sessions —
   * the caller (sync loop in Task 23) is expected to drain
   * {@link outgoingRequests} which will surface any `keys_claim` requests the
   * wasm produces.
   */
  async shareRoomKey(roomId: string, memberMatrixIds: string[]): Promise<OutgoingRequest[]> {
    const users = memberMatrixIds.map((id) => new UserId(id));
    const reqs = await this.machine.shareRoomKey(new RoomId(roomId), users, new EncryptionSettings());
    const out: OutgoingRequest[] = [];
    for (const r of reqs) {
      // `shareRoomKey` only ever returns ToDeviceRequest items.
      const id = r.id;
      this.pendingTypes.set(id, r.type);
      out.push({
        id,
        type: requestTypeToString(r.type),
        body: r.body,
        event_type: r.event_type,
        txn_id: r.txn_id,
      });
    }
    return out;
  }

  /**
   * Returns a `keys_claim` request that establishes Olm sessions with the
   * given users' devices, or `null` if no claim is needed. Callers must mark
   * the request as sent once the server responds.
   */
  async getMissingSessions(matrixIds: string[]): Promise<OutgoingRequest | null> {
    const users = matrixIds.map((id) => new UserId(id));
    const req = await this.machine.getMissingSessions(users);
    if (!req) return null;
    this.pendingTypes.set(req.id, req.type);
    return {
      id: req.id,
      type: requestTypeToString(req.type),
      body: req.body,
    };
  }

  async encryptForRoom(
    roomId: string,
    plaintext: string,
    eventType: string,
  ): Promise<{ ciphertext: string }> {
    const content = JSON.stringify({ body: plaintext, msgtype: "m.text" });
    const ciphertext = await this.machine.encryptRoomEvent(
      new RoomId(roomId),
      eventType,
      content,
    );
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
      event_id: `$bot-${Date.now()}-${randomSuffix()}`,
      origin_server_ts: Date.now(),
      room_id: roomId,
    });
    const decrypted = await this.machine.decryptRoomEvent(
      event,
      new RoomId(roomId),
      new DecryptionSettings(TrustRequirement.Untrusted),
    );
    const parsed = JSON.parse(decrypted.event) as { content?: { body?: string } };
    return parsed.content?.body ?? "";
  }

  async persist(): Promise<void> {
    const databases = await snapshotIdb(this.storeName);
    const envelope: SnapshotEnvelope = {
      v: 1,
      storeName: this.storeName,
      deviceId: this.deviceId,
      matrixId: this.matrixId,
      passphrase: this.passphrase,
      databases,
    };
    await this.store.save(encodeSnapshot(envelope));
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function requestTypeToString(t: RequestType): OutgoingRequestType {
  switch (t) {
    case RequestType.KeysUpload:
      return "keys_upload";
    case RequestType.KeysQuery:
      return "keys_query";
    case RequestType.KeysClaim:
      return "keys_claim";
    case RequestType.ToDevice:
      return "to_device";
    case RequestType.SignatureUpload:
      return "signature_upload";
    case RequestType.RoomMessage:
      return "room_message";
    case RequestType.KeysBackup:
      return "keys_backup";
    default:
      throw new Error(`BotOlmMachine: unknown RequestType ${String(t)}`);
  }
}

function generateDeviceId(): string {
  // Matrix spec leaves device id format open; 10 uppercase A-Z0-9 chars
  // matches the convention element-web uses and keeps the id short enough to
  // log conveniently.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 10; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function encodeSnapshot(env: SnapshotEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(env));
}

function decodeSnapshot(blob: Uint8Array): SnapshotEnvelope {
  const env = JSON.parse(new TextDecoder().decode(blob)) as SnapshotEnvelope;
  if (env.v !== 1) {
    throw new Error(`BotOlmMachine: unsupported snapshot version ${String(env.v)}`);
  }
  return env;
}

// ── IndexedDB snapshot / restore ───────────────────────────────────────────

/**
 * Dump every record from every database whose name begins with `${storeName}`.
 * matrix-sdk-crypto-wasm uses up to two DBs per store name: `<name>` and
 * `<name>::matrix-sdk-crypto-meta`. We iterate `indexedDB.databases()` so we
 * pick up whichever ones actually exist.
 */
async function snapshotIdb(storeName: string): Promise<SnapshotDatabase[]> {
  const all = await listAllDatabases();
  const matching = all.filter((db) => db.name === storeName || db.name.startsWith(storeName + "::"));
  const dumps: SnapshotDatabase[] = [];
  for (const meta of matching) {
    const db = await openDb(meta.name, meta.version);
    if (!db) continue;
    try {
      const objectStores: SnapshotObjectStore[] = [];
      for (const osName of Array.from(db.objectStoreNames)) {
        const records = await dumpStore(db, osName);
        objectStores.push({ name: osName, records });
      }
      dumps.push({ name: meta.name, version: db.version, objectStores });
    } finally {
      db.close();
    }
  }
  return dumps;
}

async function restoreIdb(databases: SnapshotDatabase[]): Promise<void> {
  for (const dbDump of databases) {
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
        try {
          const tx = db.transaction(Array.from(db.objectStoreNames), "readwrite");
          for (const os of dbDump.objectStores) {
            if (!db.objectStoreNames.contains(os.name)) continue;
            const objectStore = tx.objectStore(os.name);
            objectStore.clear();
            for (const rec of os.records) {
              objectStore.put(decodeSnapshotValue(rec.value), decodeSnapshotValue(rec.key) as IDBValidKey);
            }
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        } catch (err) {
          db.close();
          reject(err);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }
}

async function listAllDatabases(): Promise<Array<{ name: string; version: number }>> {
  // `indexedDB.databases()` is a standard method that fake-indexeddb supports.
  const dbs = await indexedDB.databases();
  const out: Array<{ name: string; version: number }> = [];
  for (const db of dbs) {
    if (typeof db.name === "string" && typeof db.version === "number") {
      out.push({ name: db.name, version: db.version });
    }
  }
  return out;
}

function openDb(name: string, version: number): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name, version);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function dumpStore(db: IDBDatabase, storeName: string): Promise<SnapshotRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const objectStore = tx.objectStore(storeName);
    const out: SnapshotRecord[] = [];
    const cursorReq = objectStore.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        out.push({
          key: encodeSnapshotValue(cursor.key),
          value: encodeSnapshotValue(cursor.value),
        });
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

function encodeSnapshotValue(v: unknown): SnapshotValue {
  if (v instanceof Uint8Array) {
    return { t: "bytes", v: bytesToBase64(v) };
  }
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return { t: "bytes", v: bytesToBase64(bytes) };
  }
  if (v instanceof ArrayBuffer) {
    return { t: "bytes", v: bytesToBase64(new Uint8Array(v)) };
  }
  return { t: "json", v };
}

function decodeSnapshotValue(v: SnapshotValue): unknown {
  if (v.t === "bytes") {
    return base64ToBytes(v.v);
  }
  return v.v;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Use Buffer in Node; falls back to btoa loop elsewhere.
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  // eslint-disable-next-line no-undef
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(b64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  // eslint-disable-next-line no-undef
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
