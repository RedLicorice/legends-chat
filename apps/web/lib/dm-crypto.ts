"use client";
// Legends Chat DM crypto wrapper around @matrix-org/matrix-sdk-crypto-wasm
// (vodozemac, compiled to WASM via wasm-bindgen).
//
// This module replaces the older `dm-olm.ts` implementation, which depended on
// `@matrix-org/olm` (bundler-hostile, ships its own legacy WASM init). The
// matrix-sdk-crypto-wasm `OlmMachine` is the modern Rust-based crypto core used
// by Element X and matrix-rust-sdk. It persists its state in IndexedDB.
//
// Public API (see exported declarations at the bottom):
//   - initCrypto(userId)            -> create/load OlmMachine, return CryptoSession
//   - bootstrap()                   -> drain initial outgoing requests (/keys/upload etc.)
//   - ensurePeerTracked(peerId)     -> updateTrackedUsers + queryKeys flush
//   - ensureSessionWithPeer(peerId) -> getMissingSessions + claim, then drain
//   - encryptDm(roomId, plaintext)  -> share room key + encryptRoomEvent
//   - decryptDm(roomId, envelope)   -> decryptRoomEvent on a fake m.room.encrypted event
//   - pumpOutgoing()                -> drain outgoingRequests until empty
//   - pollSync()                    -> fetch /api/crypto/sync, feed receiveSyncChanges
//   - getPeerFingerprint(peerId)    -> formatted ed25519 string for safety modal
//   - freeResources()               -> close() the OlmMachine
//
// Server endpoint contract (implemented separately in task 36):
//   POST /api/crypto/keys/upload                     body = KeysUploadRequest.body
//        resp = { one_time_key_counts: { signed_curve25519: number } }
//   POST /api/crypto/keys/query                      body = KeysQueryRequest.body
//        resp = { device_keys, master_keys, self_signing_keys, user_signing_keys }
//   POST /api/crypto/keys/claim                      body = KeysClaimRequest.body
//        resp = { one_time_keys, failures: {} }
//   PUT  /api/crypto/sendToDevice/:event_type/:txn_id  body = ToDeviceRequest.body
//        resp = {}
//   GET  /api/crypto/sync?since=<cursor>
//        resp = {
//          next_batch,
//          to_device: { events: [...] },
//          device_lists: { changed: [...], left: [...] },
//          device_one_time_keys_count: { signed_curve25519: N },
//          device_unused_fallback_key_types: [...]
//        }

import * as MatrixSdkCrypto from "@matrix-org/matrix-sdk-crypto-wasm";

// We use the imported namespace directly. wasm-bindgen exports each class as
// a named export, plus `initAsync` from the package root.
const {
  initAsync,
  OlmMachine,
  UserId,
  DeviceId,
  RoomId,
  DeviceLists,
  EncryptionSettings,
  RequestType,
} = MatrixSdkCrypto;

type OlmMachineT = InstanceType<typeof MatrixSdkCrypto.OlmMachine>;
type ProcessedToDeviceEventT = Awaited<
  ReturnType<OlmMachineT["receiveSyncChanges"]>
>[number];

// ── Public types ──────────────────────────────────────────────────────────────

export type CryptoSession = {
  /** Raw users.id UUID. */
  userId: string;
  /** Matrix-formatted user id: "@<userId>:legends.local". */
  matrixUserId: string;
  /** Stable per-browser device id (10-char base32). */
  deviceId: string;
  /** Formatted ed25519 fingerprint, suitable for the safety-number modal. */
  fingerprint: string;
  /** Raw base64 identity keys. */
  identityKeys: { ed25519: string; curve25519: string };
};

export type EncryptedEnvelope = {
  // Shape returned by `OlmMachine.encryptRoomEvent`, ready to POST to
  // /api/dm/[id]/messages. Megolm room events emit:
  //   { algorithm, sender_key, ciphertext, session_id, device_id }
  algorithm: string;
  ciphertext: string;
  sender_key: string;
  session_id?: string;
  device_id?: string;
};

export type IncomingEnvelope = {
  type: "m.room.encrypted";
  /** Matrix user id of the sender, e.g. "@<userId>:legends.local". */
  sender: string;
  content: EncryptedEnvelope;
  /** Caller maps our DM message id → fake event_id (decryptRoomEvent requires one). */
  event_id: string;
  origin_server_ts: number;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const HOMESERVER = "legends.local";
const META_DB_NAME = "legends-crypto-meta";
const META_STORE = "meta";
const CRYPTO_STORE_PREFIX = "legends-crypto-store";
const DEVICE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, no 0/1/O/I

// ── IndexedDB helpers for our metadata store (separate from the OlmMachine's
//    IndexedDB store which it manages internally) ─────────────────────────────

let cachedMetaDb: IDBDatabase | null = null;

function openMetaDb(): Promise<IDBDatabase> {
  if (cachedMetaDb) return Promise.resolve(cachedMetaDb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(META_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(META_STORE);
    req.onsuccess = () => {
      cachedMetaDb = req.result;
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

async function metaGet<T>(key: string): Promise<T | undefined> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const r = tx.objectStore(META_STORE).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

async function metaPut<T>(key: string, value: T): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put(value as unknown as IDBValidKey, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Device id generation ──────────────────────────────────────────────────────

function generateDeviceId(): string {
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += DEVICE_ID_ALPHABET[buf[i]! % DEVICE_ID_ALPHABET.length];
  }
  return out;
}

async function getOrCreateDeviceId(userId: string): Promise<string> {
  const key = `device:${userId}`;
  const existing = await metaGet<string>(key);
  if (existing) return existing;
  const fresh = generateDeviceId();
  await metaPut(key, fresh);
  return fresh;
}

// ── Singleton OlmMachine ──────────────────────────────────────────────────────

let machinePromise: Promise<OlmMachineT> | null = null;
let cachedSession: CryptoSession | null = null;

function toMatrixUserId(userId: string): string {
  return `@${userId}:${HOMESERVER}`;
}

function formatFingerprint(b64: string): string {
  // Group base64 in chunks of 4 (joined with spaces) for the safety modal.
  // This is a placeholder — the eventual UX may instead show a hash of both
  // peers' fingerprints (Signal-style). For now we expose the device's own
  // ed25519 public key in a human-comparable form.
  const groups: string[] = [];
  for (let i = 0; i < b64.length; i += 4) {
    groups.push(b64.slice(i, i + 4));
  }
  return groups.join(" ");
}

async function getMachine(): Promise<OlmMachineT> {
  if (!machinePromise) {
    throw new Error(
      "dm-crypto: OlmMachine not initialized; call initCrypto() first",
    );
  }
  return machinePromise;
}

export async function initCrypto(userId: string): Promise<CryptoSession> {
  if (cachedSession && cachedSession.userId === userId) {
    return cachedSession;
  }

  // Load the WASM (idempotent).
  await initAsync();

  const matrixUserId = toMatrixUserId(userId);
  const deviceId = await getOrCreateDeviceId(userId);

  // Per-user store name; passphrase is empty (we trust the same-origin
  // IndexedDB sandbox). If at-rest encryption is desired later, derive a
  // passphrase from the user's session and pass it here.
  const storeName = `${CRYPTO_STORE_PREFIX}-${userId}`;

  machinePromise = OlmMachine.initialize(
    new UserId(matrixUserId),
    new DeviceId(deviceId),
    storeName,
  );

  const machine = await machinePromise;
  const ik = machine.identityKeys;
  const ed25519 = ik.ed25519.toBase64();
  const curve25519 = ik.curve25519.toBase64();
  const fingerprint = formatFingerprint(ed25519);

  cachedSession = {
    userId,
    matrixUserId,
    deviceId,
    fingerprint,
    identityKeys: { ed25519, curve25519 },
  };
  return cachedSession;
}

// ── Request dispatch ──────────────────────────────────────────────────────────

async function postJson<T>(path: string, body: string): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`dm-crypto: POST ${path} failed: ${res.status} ${txt}`);
  }
  return (await res.json()) as T;
}

async function putJson<T>(path: string, body: string): Promise<T> {
  // sendToDevice is the only PUT we issue today, and the server requires the
  // caller to identify which device is fanning out (so it can stamp the
  // to-device row's sender_device_id). We pull the deviceId from the cached
  // session — initCrypto must have run before any pumpOutgoing call reaches
  // here, so cachedSession is always populated at this point.
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cachedSession?.deviceId) {
    headers["x-legends-crypto-device-id"] = cachedSession.deviceId;
  }
  const res = await fetch(path, {
    method: "PUT",
    credentials: "include",
    headers,
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`dm-crypto: PUT ${path} failed: ${res.status} ${txt}`);
  }
  return (await res.json()) as T;
}

// outgoingRequests() returns a union — we narrow with a discriminant. Each
// concrete request type has a `type: RequestType` (numeric enum).
type AnyOutgoingRequest = Awaited<
  ReturnType<OlmMachineT["outgoingRequests"]>
>[number];

async function dispatchOne(
  req: AnyOutgoingRequest,
): Promise<{ requestId: string; requestType: MatrixSdkCrypto.RequestType; responseBody: string }> {
  // Each branch handles the union narrowing via the `type` discriminant.
  // `id` is `string | undefined` on SignatureUploadRequest only; everywhere
  // else it's a plain string.
  switch (req.type) {
    case RequestType.KeysUpload: {
      const r = req as MatrixSdkCrypto.KeysUploadRequest;
      const resp = await postJson<unknown>("/api/crypto/keys/upload", r.body);
      return { requestId: r.id, requestType: r.type, responseBody: JSON.stringify(resp) };
    }
    case RequestType.KeysQuery: {
      const r = req as MatrixSdkCrypto.KeysQueryRequest;
      const resp = await postJson<unknown>("/api/crypto/keys/query", r.body);
      return { requestId: r.id, requestType: r.type, responseBody: JSON.stringify(resp) };
    }
    case RequestType.KeysClaim: {
      const r = req as MatrixSdkCrypto.KeysClaimRequest;
      const resp = await postJson<unknown>("/api/crypto/keys/claim", r.body);
      return { requestId: r.id, requestType: r.type, responseBody: JSON.stringify(resp) };
    }
    case RequestType.ToDevice: {
      const r = req as MatrixSdkCrypto.ToDeviceRequest;
      const path = `/api/crypto/sendToDevice/${encodeURIComponent(
        r.event_type,
      )}/${encodeURIComponent(r.txn_id)}`;
      const resp = await putJson<unknown>(path, r.body);
      return { requestId: r.id, requestType: r.type, responseBody: JSON.stringify(resp) };
    }
    case RequestType.SignatureUpload: {
      // Not used for DM (no cross-signing yet). We acknowledge to the machine
      // without round-tripping to a real endpoint to avoid wedging the queue.
      // If we later add cross-signing support, route to /api/crypto/keys/signatures/upload.
      const r = req as MatrixSdkCrypto.SignatureUploadRequest;
      const id = r.id ?? "noop";
      return { requestId: id, requestType: r.type, responseBody: "{}" };
    }
    case RequestType.RoomMessage: {
      // Not used in our DM flow (we send via /api/dm/[id]/messages directly,
      // not via the Matrix RoomMessage path). Stub-acknowledge.
      const r = req as MatrixSdkCrypto.RoomMessageRequest;
      return { requestId: r.id, requestType: r.type, responseBody: '{"event_id":"$noop"}' };
    }
    case RequestType.KeysBackup: {
      // No server-side backup endpoint yet. Stub-acknowledge.
      const r = req as MatrixSdkCrypto.KeysBackupRequest;
      return { requestId: r.id, requestType: r.type, responseBody: "{}" };
    }
    default: {
      // Exhaustiveness check
      const _exhaustive: never = req as never;
      throw new Error(`dm-crypto: unknown outgoing request type: ${String(_exhaustive)}`);
    }
  }
}

export async function pumpOutgoing(): Promise<void> {
  const machine = await getMachine();
  // Cap iterations to avoid an unbounded loop on a misbehaving server.
  for (let i = 0; i < 32; i++) {
    const reqs = await machine.outgoingRequests();
    if (reqs.length === 0) return;
    for (const req of reqs) {
      const { requestId, requestType, responseBody } = await dispatchOne(req);
      await machine.markRequestAsSent(requestId, requestType, responseBody);
    }
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

export async function bootstrap(): Promise<void> {
  await getMachine();
  // First call to outgoingRequests() produces a KeysUploadRequest with the
  // device's identity keys + initial OTKs. Drain everything the machine wants
  // to publish.
  await pumpOutgoing();
}

// ── Tracking peers and establishing sessions ─────────────────────────────────

export async function ensurePeerTracked(peerUserId: string): Promise<void> {
  const machine = await getMachine();
  const matrixPeer = toMatrixUserId(peerUserId);
  await machine.updateTrackedUsers([new UserId(matrixPeer)]);
  // updateTrackedUsers schedules a /keys/query in the background; flush it.
  await pumpOutgoing();
}

export async function ensureSessionWithPeer(peerUserId: string): Promise<void> {
  const machine = await getMachine();
  const matrixPeer = toMatrixUserId(peerUserId);
  const claim = await machine.getMissingSessions([new UserId(matrixPeer)]);
  if (claim) {
    const resp = await postJson<unknown>("/api/crypto/keys/claim", claim.body);
    await machine.markRequestAsSent(claim.id, claim.type, JSON.stringify(resp));
  }
  // Drain any follow-up requests (to-device etc.) that the machine queued.
  await pumpOutgoing();
}

// ── Encrypt / decrypt ─────────────────────────────────────────────────────────

function buildEncryptionSettings(): MatrixSdkCrypto.EncryptionSettings {
  // Defaults are appropriate for 1:1 DMs (MegolmV1AesSha2). We leave rotation
  // periods at the SDK defaults for now.
  return new EncryptionSettings();
}

export async function encryptDm(
  roomId: string,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  const machine = await getMachine();
  const session = cachedSession;
  if (!session) throw new Error("dm-crypto: not initialized");

  const room = new RoomId(roomId);

  // Caller is expected to have already called ensurePeerTracked +
  // ensureSessionWithPeer for the peer. We still call shareRoomKey here to
  // make sure a megolm outbound session exists for `room` — when the session
  // is already shared this is a no-op.
  //
  // shareRoomKey requires the full peer set for the room. For a 1:1 DM, the
  // members are { self, peer }. The OlmMachine internally tracks "us" via
  // userId, so we only need to pass the peer here. We don't know which peer
  // belongs to this room from this signature, so we infer "all tracked users
  // who aren't us". This is correct for 1:1 DMs but would need refinement
  // for group rooms.
  const tracked = await machine.trackedUsers();
  const others: MatrixSdkCrypto.UserId[] = [];
  for (const u of tracked) {
    if (u.toString() !== session.matrixUserId) {
      // updateTrackedUsers / trackedUsers invalidate UserId objects after they
      // pass through the machine, but `trackedUsers()` returns fresh handles.
      others.push(u);
    }
  }

  const todeviceReqs = await machine.shareRoomKey(
    room,
    others,
    buildEncryptionSettings(),
  );
  for (const req of todeviceReqs) {
    const path = `/api/crypto/sendToDevice/${encodeURIComponent(
      req.event_type,
    )}/${encodeURIComponent(req.txn_id)}`;
    const resp = await putJson<unknown>(path, req.body);
    await machine.markRequestAsSent(req.id, req.type, JSON.stringify(resp));
  }
  // Drain anything else queued as a side effect (e.g. queries triggered by
  // device-list changes).
  await pumpOutgoing();

  const contentJson = await machine.encryptRoomEvent(
    new RoomId(roomId),
    "m.room.message",
    JSON.stringify({ msgtype: "m.text", body: plaintext }),
  );
  return JSON.parse(contentJson) as EncryptedEnvelope;
}

export async function decryptDm(
  roomId: string,
  envelope: IncomingEnvelope,
): Promise<string> {
  const machine = await getMachine();
  // decryptRoomEvent expects a full Matrix event JSON. We build one from the
  // envelope shape we receive from /api/dm/[id]/messages.
  const eventJson = JSON.stringify({
    type: envelope.type,
    sender: envelope.sender,
    content: envelope.content,
    event_id: envelope.event_id,
    origin_server_ts: envelope.origin_server_ts,
    room_id: roomId,
  });
  const decryptionSettings = new MatrixSdkCrypto.DecryptionSettings(
    MatrixSdkCrypto.TrustRequirement.Untrusted,
  );
  const decrypted = await machine.decryptRoomEvent(
    eventJson,
    new RoomId(roomId),
    decryptionSettings,
  );
  const inner = JSON.parse(decrypted.event) as {
    type?: string;
    content?: { body?: string; msgtype?: string };
  };
  return inner.content?.body ?? "";
}

// ── Sync polling ──────────────────────────────────────────────────────────────

type SyncResponse = {
  next_batch: string;
  to_device?: { events?: unknown[] };
  device_lists?: { changed?: string[]; left?: string[] };
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
};

export async function pollSync(): Promise<{ newToDeviceCount: number }> {
  const machine = await getMachine();
  const session = cachedSession;
  if (!session) throw new Error("dm-crypto: not initialized");
  const cursorKey = `sync_cursor:${session.userId}:${session.deviceId}`;
  const since = (await metaGet<string>(cursorKey)) ?? "";

  // The server scopes the to-device queue + OTK count by device. Without
  // `device_id` it returns 400 and we'd never receive room keys.
  const qp = new URLSearchParams({ device_id: session.deviceId });
  if (since) qp.set("since", since);
  const url = `/api/crypto/sync?${qp.toString()}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`dm-crypto: GET ${url} failed: ${res.status} ${txt}`);
  }
  const body = (await res.json()) as SyncResponse;

  const events = body.to_device?.events ?? [];
  const changed = (body.device_lists?.changed ?? []).map((u) => new UserId(u));
  const left = (body.device_lists?.left ?? []).map((u) => new UserId(u));
  const deviceLists = new DeviceLists(changed, left);

  const otkCounts = new Map<string, number>(
    Object.entries(body.device_one_time_keys_count ?? {}),
  );
  const unusedFallback = new Set<string>(
    body.device_unused_fallback_key_types ?? [],
  );

  const processed: ProcessedToDeviceEventT[] = await machine.receiveSyncChanges(
    JSON.stringify(events),
    deviceLists,
    otkCounts,
    unusedFallback,
  );

  // Persist the new cursor regardless of how many events we got.
  await metaPut(cursorKey, body.next_batch);

  // Drain follow-up requests (e.g. queued KeysQuery for changed devices,
  // KeysUpload to top up OTKs).
  await pumpOutgoing();

  return { newToDeviceCount: processed.length };
}

// ── Fingerprints ──────────────────────────────────────────────────────────────

export async function getPeerFingerprint(
  peerUserId: string,
): Promise<string | null> {
  const machine = await getMachine();
  const matrixPeer = toMatrixUserId(peerUserId);
  const devices = await machine.getUserDevices(new UserId(matrixPeer), null);
  const all = devices.devices();
  if (all.length === 0) return null;
  // For 1:1 DMs we typically pick the first non-deleted device. A future
  // version of the safety modal should let the user pick among multiple
  // devices and display a per-device fingerprint.
  for (const dev of all) {
    if (dev.isDeleted()) continue;
    const ed = dev.ed25519Key;
    if (!ed) continue;
    return formatFingerprint(ed.toBase64());
  }
  return null;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

export async function freeResources(): Promise<void> {
  if (!machinePromise) return;
  try {
    const m = await machinePromise;
    m.close();
  } catch {
    // ignore
  }
  machinePromise = null;
  cachedSession = null;
}
