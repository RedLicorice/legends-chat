"use client";
// Legends Chat crypto wrapper around @matrix-org/matrix-sdk-crypto-wasm
// (vodozemac, compiled to WASM via wasm-bindgen).
//
// This module is the single client-side surface for E2EE. It handles both:
//   - 1:1 DM rooms (peer-set inferred from the caller passing the peer userId)
//   - Group rooms (topics) where the caller passes the full member list
//
// Public API (see exported declarations at the bottom):
//   - initCrypto(userId)                        -> create/load OlmMachine
//   - bootstrap()                               -> drain initial outgoing reqs
//   - getMyFingerprint()                        -> formatted ed25519 of own device
//   - pumpOutgoing()                            -> drain outgoingRequests
//   - pollSync()                                -> fetch /api/crypto/sync, feed receiveSyncChanges
//   - freeResources()                           -> close() the OlmMachine
//
//   DM ops (1:1):
//     - ensurePeerTracked(peerUserId)           -> updateTrackedUsers + queryKeys flush
//     - ensureSessionWithPeer(peerUserId)       -> ensureRoomMembers(roomId, [peer]) shortcut
//     - encryptDm(roomId, plaintext)            -> delegates to encryptRoom
//     - decryptDm(roomId, envelope)             -> delegates to decryptRoom
//     - getPeerFingerprint(peerUserId)          -> formatted ed25519 for safety modal
//
//   Group room ops (topics, multi-recipient):
//     - ensureRoomMembers(roomId, userIds)      -> track + claim + shareRoomKey
//     - encryptRoom(roomId, plaintext)          -> encryptRoomEvent
//     - decryptRoom(roomId, envelope)           -> decryptRoomEvent
//     - onMembershipChange(roomId, action, ...) -> invalidateGroupSession + reshare
//     - getRoomFingerprint(roomId, userIds)     -> SHA-256 hash of sorted ed25519 keys
//
// Server endpoint contract (unchanged from the DM-only version):
//   POST /api/crypto/keys/upload                     body = KeysUploadRequest.body
//   POST /api/crypto/keys/query                      body = KeysQueryRequest.body
//   POST /api/crypto/keys/claim                      body = KeysClaimRequest.body
//   PUT  /api/crypto/sendToDevice/:event_type/:txn_id  body = ToDeviceRequest.body
//   GET  /api/crypto/sync?since=<cursor>&device_id=<id>

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
  // /api/dm/[id]/messages (DM) or the topic message endpoint (group).
  // Megolm room events emit:
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
  /** Caller maps message id → fake event_id (decryptRoomEvent requires one). */
  event_id: string;
  origin_server_ts: number;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const HOMESERVER = "legends.local";
const META_DB_NAME = "legends-crypto-meta";
const META_STORE = "meta";
const CRYPTO_STORE_PREFIX = "legends-crypto-store";
const DEVICE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, no 0/1/O/I

/** Megolm session rotation policy (also useful to surface server-side). */
export const MEGOLM_ROTATION_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
export const MEGOLM_ROTATION_MESSAGES = 100;

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
  // For the DM case this is the device's own ed25519 public key. For group
  // rooms we use SHA-256 over the sorted member ed25519 keys (see
  // getRoomFingerprint) and pass that through this same formatter so the
  // visual treatment is consistent across modals.
  const groups: string[] = [];
  for (let i = 0; i < b64.length; i += 4) {
    groups.push(b64.slice(i, i + 4));
  }
  return groups.join(" ");
}

async function getMachine(): Promise<OlmMachineT> {
  if (!machinePromise) {
    throw new Error(
      "crypto: OlmMachine not initialized; call initCrypto() first",
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
  // IndexedDB sandbox).
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

export async function getMyFingerprint(): Promise<string> {
  if (!cachedSession) throw new Error("crypto: not initialized");
  return cachedSession.fingerprint;
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
    throw new Error(`crypto: POST ${path} failed: ${res.status} ${txt}`);
  }
  return (await res.json()) as T;
}

async function putJson<T>(path: string, body: string): Promise<T> {
  // sendToDevice is the only PUT we issue today, and the server requires the
  // caller to identify which device is fanning out (so it can stamp the
  // to-device row's sender_device_id).
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
    throw new Error(`crypto: PUT ${path} failed: ${res.status} ${txt}`);
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
      // Not used (no cross-signing yet). Stub-acknowledge.
      const r = req as MatrixSdkCrypto.SignatureUploadRequest;
      const id = r.id ?? "noop";
      return { requestId: id, requestType: r.type, responseBody: "{}" };
    }
    case RequestType.RoomMessage: {
      // Not used in our flow (we send via app-specific endpoints).
      const r = req as MatrixSdkCrypto.RoomMessageRequest;
      return { requestId: r.id, requestType: r.type, responseBody: '{"event_id":"$noop"}' };
    }
    case RequestType.KeysBackup: {
      // No server-side backup endpoint yet. Stub-acknowledge.
      const r = req as MatrixSdkCrypto.KeysBackupRequest;
      return { requestId: r.id, requestType: r.type, responseBody: "{}" };
    }
    default: {
      const _exhaustive: never = req as never;
      throw new Error(`crypto: unknown outgoing request type: ${String(_exhaustive)}`);
    }
  }
}

// Single-flight mutex for pumpOutgoing.
//
// Background: many call sites (pollSync, ensureRoomMembers, send-retry in
// TopicView, DM helpers) call pumpOutgoing. When two pump invocations
// interleave, both observe the same `outgoingRequests()` array, both
// dispatch each request, and both call `markRequestAsSent`. The OlmMachine
// state machine treats the duplicate response as a fresh round-trip and
// re-issues the next-step requests (most visibly: KeysQuery repeats
// indefinitely). The result is a runaway loop hammering /api/crypto/keys/query
// until rate-limited, and encryption never converges.
//
// The mutex guarantees: at any moment AT MOST ONE pump cycle is in flight.
// Concurrent callers all await the same in-flight promise. After it
// resolves, the next caller may start a fresh cycle (state may have
// advanced). This preserves correctness — every request the machine wants
// to emit still gets dispatched exactly once — while eliminating the
// duplicate-response feedback loop.
let pumpInFlight: Promise<void> | null = null;

export async function pumpOutgoing(): Promise<void> {
  if (pumpInFlight) {
    // A pump is already running; wait for it and return.
    // Don't start a second concurrent cycle.
    await pumpInFlight;
    return;
  }
  pumpInFlight = (async () => {
    try {
      const machine = await getMachine();
      // Cap iterations to avoid an unbounded loop on a misbehaving server
      // or a wrapper bug. 32 is generous — a healthy bootstrap takes ≤4.
      for (let i = 0; i < 32; i++) {
        const reqs = await machine.outgoingRequests();
        if (reqs.length === 0) return;
        for (const req of reqs) {
          const { requestId, requestType, responseBody } = await dispatchOne(req);
          await machine.markRequestAsSent(requestId, requestType, responseBody);
        }
      }
    } finally {
      pumpInFlight = null;
    }
  })();
  await pumpInFlight;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

export async function bootstrap(): Promise<void> {
  await getMachine();
  // First call to outgoingRequests() produces a KeysUploadRequest with the
  // device's identity keys + initial OTKs. Drain everything the machine wants
  // to publish.
  await pumpOutgoing();
}

// ── Tracking peers and establishing sessions (DM convenience) ────────────────

export async function ensurePeerTracked(peerUserId: string): Promise<void> {
  const machine = await getMachine();
  const matrixPeer = toMatrixUserId(peerUserId);
  await machine.updateTrackedUsers([new UserId(matrixPeer)]);
  // updateTrackedUsers schedules a /keys/query in the background; flush it.
  await pumpOutgoing();
}

export async function ensureSessionWithPeer(peerUserId: string): Promise<void> {
  // DM convenience: delegate to the group-aware helper with a single peer.
  // The self device is implicit (OlmMachine internally treats "us" via userId).
  // The roomId is not needed for ensureRoomMembers's session-claim step —
  // that step only requires the peer set — so we pass a placeholder. The
  // actual shareRoomKey runs later from encryptRoom() / encryptDm() where the
  // real roomId is known.
  await ensureRoomMembersPeers([peerUserId]);
}

/**
 * Internal: do the per-peer "track + claim" half of ensureRoomMembers without
 * requiring a roomId. Used by the DM convenience helpers — the actual
 * shareRoomKey for the room happens from encryptDm/encryptRoom which already
 * call shareRoomKey before encryptRoomEvent.
 */
async function ensureRoomMembersPeers(userIds: string[]): Promise<void> {
  const machine = await getMachine();
  const matrixUsers = userIds.map((u) => new UserId(toMatrixUserId(u)));
  await machine.updateTrackedUsers(matrixUsers);
  // Build a fresh UserId list (the previous ones were consumed by
  // updateTrackedUsers — wasm-bindgen "moves" UserId handles).
  const claimUsers = userIds.map((u) => new UserId(toMatrixUserId(u)));
  const claim = await machine.getMissingSessions(claimUsers);
  if (claim) {
    const resp = await postJson<unknown>("/api/crypto/keys/claim", claim.body);
    await machine.markRequestAsSent(claim.id, claim.type, JSON.stringify(resp));
  }
  // Single pump drains the KeysQuery scheduled by updateTrackedUsers plus
  // any follow-ups. Routed through the single-flight mutex.
  await pumpOutgoing();
}

// ── Encrypt / decrypt ─────────────────────────────────────────────────────────

function buildEncryptionSettings(): MatrixSdkCrypto.EncryptionSettings {
  // MegolmV1AesSha2 (default algorithm). Apply our 1-week / 100-message
  // rotation policy. The wasm binding takes `rotationPeriod` in MICROSECONDS,
  // and both rotation properties are `bigint`.
  const s = new EncryptionSettings();
  s.rotationPeriod = BigInt(MEGOLM_ROTATION_PERIOD_MS) * BigInt(1000);
  s.rotationPeriodMessages = BigInt(MEGOLM_ROTATION_MESSAGES);
  return s;
}

/**
 * Ensure that a Megolm outbound session exists for `roomId` and that all
 * listed members have received the room key. Idempotent — when the session
 * already covers the member set, shareRoomKey returns an empty array.
 *
 * Callers are responsible for passing the *current* member list (including
 * themselves). The OlmMachine treats the self-user implicitly when
 * sharing — passing self in the list is harmless.
 */
export async function ensureRoomMembers(
  roomId: string,
  userIds: string[],
): Promise<void> {
  const machine = await getMachine();
  // 1) Make sure we have current device lists for everyone. This schedules
  //    a KeysQuery internally; we drain it in the single pump at the end.
  const trackUsers = userIds.map((u) => new UserId(toMatrixUserId(u)));
  await machine.updateTrackedUsers(trackUsers);
  // 2) Establish Olm 1:1 sessions with every device that's missing one (these
  //    are the channels Megolm room keys ride on). getMissingSessions returns
  //    a KeysClaim request directly — handle it inline.
  const claimUsers = userIds.map((u) => new UserId(toMatrixUserId(u)));
  const claim = await machine.getMissingSessions(claimUsers);
  if (claim) {
    const resp = await postJson<unknown>("/api/crypto/keys/claim", claim.body);
    await machine.markRequestAsSent(claim.id, claim.type, JSON.stringify(resp));
  }
  // 3) Share the Megolm outbound session with everyone (no-op if already shared).
  const shareUsers = userIds.map((u) => new UserId(toMatrixUserId(u)));
  const todeviceReqs = await machine.shareRoomKey(
    new RoomId(roomId),
    shareUsers,
    buildEncryptionSettings(),
  );
  for (const req of todeviceReqs) {
    const path = `/api/crypto/sendToDevice/${encodeURIComponent(
      req.event_type,
    )}/${encodeURIComponent(req.txn_id)}`;
    const resp = await putJson<unknown>(path, req.body);
    await machine.markRequestAsSent(req.id, req.type, JSON.stringify(resp));
  }
  // Single pump at the end drains everything still queued (KeysQuery from
  // updateTrackedUsers, any follow-up KeysUpload, etc). Going through the
  // single-flight mutex ensures we don't race with pollSync's own pump.
  await pumpOutgoing();
}

/**
 * Encrypt a plaintext message for the room. Callers must have already invoked
 * `ensureRoomMembers(roomId, members)` (or, for DMs, `ensureSessionWithPeer`).
 * No member-set inference is done here.
 */
export async function encryptRoom(
  roomId: string,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  const machine = await getMachine();
  if (!cachedSession) throw new Error("crypto: not initialized");
  const contentJson = await machine.encryptRoomEvent(
    new RoomId(roomId),
    "m.room.message",
    JSON.stringify({ msgtype: "m.text", body: plaintext }),
  );
  return JSON.parse(contentJson) as EncryptedEnvelope;
}

export async function decryptRoom(
  roomId: string,
  envelope: IncomingEnvelope,
): Promise<string> {
  const machine = await getMachine();
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

// DM-flavored thin wrappers — kept for call-site clarity. Both delegate to
// the room-generic helpers. The peer-set inference that used to live in
// encryptDm has been removed; callers must call ensureSessionWithPeer (or
// ensureRoomMembers) before encrypting.

export async function encryptDm(
  roomId: string,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  return encryptRoom(roomId, plaintext);
}

export async function decryptDm(
  roomId: string,
  envelope: IncomingEnvelope,
): Promise<string> {
  return decryptRoom(roomId, envelope);
}

/**
 * Drop the current Megolm outbound session for the room and reshare a fresh
 * one with the new member set. Call this on join/leave so kicked members
 * can't decrypt future messages and new members get the next key.
 *
 * Note: when leaving, the kicked user is omitted from `newMemberList` —
 * shareRoomKey will not send the new room key to them.
 *
 * Uses `OlmMachine.invalidateGroupSession(roomId)` (the wasm SDK's name for
 * what other Matrix docs call "discard room key").
 */
export async function onMembershipChange(
  roomId: string,
  _action: "join" | "leave",
  _userId: string,
  newMemberList: string[],
): Promise<void> {
  const machine = await getMachine();
  await machine.invalidateGroupSession(new RoomId(roomId));
  await ensureRoomMembers(roomId, newMemberList);
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
  if (!session) throw new Error("crypto: not initialized");
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
    throw new Error(`crypto: GET ${url} failed: ${res.status} ${txt}`);
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
  // For 1:1 DMs we pick the first non-deleted device.
  for (const dev of all) {
    if (dev.isDeleted()) continue;
    const ed = dev.ed25519Key;
    if (!ed) continue;
    return formatFingerprint(ed.toBase64());
  }
  return null;
}

/**
 * Group-room fingerprint: SHA-256 of the concatenation of every member's
 * ed25519 device keys, sorted lexicographically. Caller passes the room's
 * member list. Returns null if any member has no usable device (so the UI
 * can render "fingerprint unavailable" instead of a misleading hash).
 *
 * The formatter matches `getMyFingerprint` / `getPeerFingerprint` so the
 * safety modal can render all three identically.
 */
export async function getRoomFingerprint(
  _roomId: string,
  userIds: string[],
): Promise<string | null> {
  const machine = await getMachine();
  const keys: string[] = [];
  for (const u of userIds) {
    const matrixUser = toMatrixUserId(u);
    const devices = await machine.getUserDevices(new UserId(matrixUser), null);
    const all = devices.devices();
    let any = false;
    for (const dev of all) {
      if (dev.isDeleted()) continue;
      const ed = dev.ed25519Key;
      if (!ed) continue;
      keys.push(ed.toBase64());
      any = true;
    }
    if (!any) return null;
  }
  keys.sort();
  const enc = new TextEncoder().encode(keys.join("|"));
  const digest = await crypto.subtle.digest("SHA-256", enc);
  // Base64-encode the 32-byte SHA-256 result so formatFingerprint produces
  // the same visual format as for ed25519 keys (also 32 bytes -> 44 b64).
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin);
  return formatFingerprint(b64);
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
