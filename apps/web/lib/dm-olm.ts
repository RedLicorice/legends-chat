"use client";
// Olm Double Ratchet wrapper for Legends Chat DMs (Plan B).
//
// Verified API surface against @matrix-org/olm 3.2.15:
//   - Olm.init({ locateFile: () => "/olm.wasm" })
//   - new Olm.Account() + account.create()
//   - account.identity_keys()  → JSON string { curve25519, ed25519 }
//   - account.generate_one_time_keys(n), account.one_time_keys()
//       → JSON string { curve25519: { "<id>": "<base64>", ... } }
//   - account.mark_keys_as_published(), account.remove_one_time_keys(session)
//   - account.pickle(key), account.unpickle(key, pickled)
//   - new Olm.Session(), session.create_outbound(account, peerCurve25519, oneTimeKey)
//   - session.create_inbound_from(account, senderCurve25519, prekeyMsgBody)
//   - session.encrypt(plaintext) → { type: 0|1, body: string }
//   - session.decrypt(type, body) → plaintext string
//   - session.pickle(key), session.unpickle(key, pickled)
//
// The "signed prekey" in Olm X3DH is the Curve25519 identity key itself — no
// separate signed-prekey generation method exists in 3.2.15.  The Ed25519
// identity key provides the signing guarantee.  Both are uploaded on each call
// to generateAndPublishKeys() (server upsert is idempotent).
//
// Storage: IndexedDB database "legends-dm-olm", object store "olm".
//   Keys:
//     "pickle-key"                  → random 32-byte base64 string (pickle password)
//     "account"                     → pickled Olm.Account string
//     "session:{convId}:{peerId}"   → StoredSession { pickled, peerIdentityCurve25519 }

import * as Olm from "@matrix-org/olm";

const DB_NAME = "legends-dm-olm";
const STORE = "olm";

// ── Types ─────────────────────────────────────────────────────────────────────

export type IdentityKeys = { curve25519: string; ed25519: string };

type StoredSession = { pickled: string; peerIdentityCurve25519: string; peerIdentityEd25519: string };

export type Envelope = { r: 1; t: 0 | 1; b: string };
// r=1 marks this as a ratcheted envelope
// t=0: Olm PreKey message (first message, establishes session)
// t=1: Olm regular message (subsequent messages, advancing ratchet)
// b: opaque ciphertext body produced by session.encrypt()

// ── WASM init ─────────────────────────────────────────────────────────────────

let olmInitPromise: Promise<void> | null = null;

async function ensureOlm(): Promise<void> {
  if (!olmInitPromise) {
    // /public/olm.wasm is pre-copied at build/setup time from
    // node_modules/@matrix-org/olm/olm.wasm.
    olmInitPromise = Olm.init({ locateFile: () => "/olm.wasm" });
  }
  return olmInitPromise;
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

let cachedDb: IDBDatabase | null = null;
function openIdb(): Promise<IDBDatabase> {
  if (cachedDb) return Promise.resolve(cachedDb);
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => { cachedDb = r.result; resolve(r.result); };
    r.onerror = () => reject(r.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Pickle key ────────────────────────────────────────────────────────────────

async function getPickleKey(): Promise<string> {
  const existing = await idbGet<string>("pickle-key");
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...bytes));
  await idbPut("pickle-key", key);
  return key;
}

// ── Account ───────────────────────────────────────────────────────────────────

/**
 * Internal: load (or create) the local Olm account.
 * The caller is responsible for calling account.free() when done.
 */
async function loadAccount(): Promise<{ account: Olm.Account; created: boolean }> {
  await ensureOlm();
  const pickleKey = await getPickleKey();
  const stored = await idbGet<string>("account");

  const account = new Olm.Account();
  let created = false;

  if (stored) {
    account.unpickle(pickleKey, stored);
  } else {
    account.create();
    created = true;
  }

  return { account, created };
}

/**
 * Re-pickle the account into IDB after any mutating Olm operation.
 * Call after generate_one_time_keys, mark_keys_as_published, remove_one_time_keys.
 */
export async function persistAccount(account: Olm.Account): Promise<void> {
  const pickleKey = await getPickleKey();
  await idbPut("account", account.pickle(pickleKey));
}

/**
 * Returns the local user's Olm identity keys without leaking the account object.
 * `created: true` means a fresh account was just generated.
 */
export async function getMyIdentityKeys(): Promise<{ curve25519: string; ed25519: string; created: boolean }> {
  const { account, created } = await loadAccount();
  try {
    const identityKeys = JSON.parse(account.identity_keys()) as IdentityKeys;
    if (created) {
      await persistAccount(account);
    }
    return { ...identityKeys, created };
  } finally {
    account.free();
  }
}

/**
 * Public façade kept for backwards compatibility.
 * Returns `{ identityKeys, created }` — does NOT expose the raw Account object.
 */
export async function getOrCreateAccount(): Promise<{
  identityKeys: IdentityKeys;
  created: boolean;
}> {
  const { curve25519, ed25519, created } = await getMyIdentityKeys();
  return { identityKeys: { curve25519, ed25519 }, created };
}

// ── Prekey generation + publish ───────────────────────────────────────────────

/**
 * Generate `oneTimeCount` one-time prekeys and POST them — along with the Olm
 * identity keys — to /api/user/keys/prekeys.
 *
 * In Olm 3.2.15 there is no separate "signed prekey" generation method.
 * The Curve25519 identity key IS the X3DH long-term identity key; the Ed25519
 * identity key provides the signing guarantee.  Both are uploaded on every call
 * (server upsert is idempotent — safe to call on each device init).
 */
export async function generateAndPublishKeys(oneTimeCount = 100): Promise<void> {
  const { account, created: _created } = await loadAccount();
  try {
    const identityKeys = JSON.parse(account.identity_keys()) as IdentityKeys;

    account.generate_one_time_keys(oneTimeCount);
    const otkJson = JSON.parse(account.one_time_keys()) as {
      curve25519: Record<string, string>;
    };
    const oneTimePrekeys = Object.entries(otkJson.curve25519).map(([id, key]) => ({ id, key }));

    const res = await fetch("/api/user/keys/prekeys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        olmIdentityCurve25519: identityKeys.curve25519,
        olmIdentityEd25519: identityKeys.ed25519,
        oneTimePrekeys,
      }),
    });
    if (!res.ok) throw new Error(`publish keys failed: ${res.status}`);

    account.mark_keys_as_published();
    await persistAccount(account);
  } finally {
    account.free();
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

function sessionKey(conversationId: string, peerUserId: string): string {
  return `session:${conversationId}:${peerUserId}`;
}


/**
 * Open an outbound (initiator) Olm session toward a peer.
 * Requires a one-time prekey from the peer's bundle; throws if none is available
 * (Olm 3.2.15 requires an OTK for outbound session creation).
 */
export async function openOutboundSession(
  conversationId: string,
  peerUserId: string,
  peerBundle: {
    olmIdentityCurve25519: string;
    olmIdentityEd25519?: string;
    oneTimePrekey: { id: string; key: string } | null;
  },
): Promise<void> {
  if (!peerBundle.oneTimePrekey) {
    throw new Error(
      "peer has no one-time prekey available — ask them to open the app so their device publishes new prekeys",
    );
  }

  const { account } = await loadAccount();
  const pickleKey = await getPickleKey();
  const session = new Olm.Session();
  try {
    session.create_outbound(
      account,
      peerBundle.olmIdentityCurve25519,
      peerBundle.oneTimePrekey.key,
    );

    await idbPut(sessionKey(conversationId, peerUserId), {
      pickled: session.pickle(pickleKey),
      peerIdentityCurve25519: peerBundle.olmIdentityCurve25519,
      peerIdentityEd25519: peerBundle.olmIdentityEd25519 ?? "",
    } satisfies StoredSession);

    await persistAccount(account);
  } finally {
    session.free();
    account.free();
  }
}

/**
 * Open an inbound Olm session from the first prekey message received from a peer.
 * Consumes the corresponding one-time prekey from the local account.
 */
export async function openInboundSession(
  conversationId: string,
  peerUserId: string,
  peerIdentityCurve25519: string,
  prekeyMessageBody: string,
  peerIdentityEd25519 = "",
): Promise<void> {
  const { account } = await loadAccount();
  const pickleKey = await getPickleKey();
  const session = new Olm.Session();
  try {
    session.create_inbound_from(account, peerIdentityCurve25519, prekeyMessageBody);
    account.remove_one_time_keys(session);

    await idbPut(sessionKey(conversationId, peerUserId), {
      pickled: session.pickle(pickleKey),
      peerIdentityCurve25519,
      peerIdentityEd25519,
    } satisfies StoredSession);

    await persistAccount(account);
  } finally {
    session.free();
    account.free();
  }
}

/** Returns true if a session for this (conversation, peer) pair is stored in IDB. */
export async function hasSession(
  conversationId: string,
  peerUserId: string,
): Promise<boolean> {
  const val = await idbGet<StoredSession>(sessionKey(conversationId, peerUserId));
  return val !== undefined;
}

/**
 * Load, use, then free an Olm Session — the caller's fn receives the live
 * session object and must NOT hold a reference after returning.  The updated
 * ratchet is re-pickled and persisted automatically.
 */
async function useSession<T>(
  convId: string,
  peerId: string,
  fn: (session: Olm.Session) => Promise<T>,
): Promise<T> {
  const stored = await idbGet<StoredSession>(sessionKey(convId, peerId));
  if (!stored) throw new Error("no session");
  await ensureOlm();
  const session = new Olm.Session();
  const pickle = await getPickleKey();
  session.unpickle(pickle, stored.pickled);
  try {
    const result = await fn(session);
    await idbPut(sessionKey(convId, peerId), {
      ...stored,
      pickled: session.pickle(pickle),
    } satisfies StoredSession);
    return result;
  } finally {
    session.free();
  }
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────────

/**
 * Encrypt `plaintext` for the peer of the given conversation.
 * Returns a JSON-serialised Envelope `{ r:1, t:0|1, b:"..." }`.
 * Requires an existing session (openOutboundSession must have been called).
 * Persists updated ratchet state after every call.
 */
export async function encrypt(
  conversationId: string,
  peerUserId: string,
  plaintext: string,
): Promise<string> {
  return useSession(conversationId, peerUserId, async (session) => {
    const { type, body } = session.encrypt(plaintext);
    const env: Envelope = { r: 1, t: type, b: body };
    return JSON.stringify(env);
  });
}

/**
 * Decrypt an Envelope produced by `encrypt()`.
 * On first message from a peer (t=0, prekey message) with no local session, an
 * inbound session is established automatically by fetching the peer's bundle.
 * Persists updated ratchet state after every call.
 */
export async function decrypt(
  conversationId: string,
  peerUserId: string,
  envelopeText: string,
): Promise<string> {
  const env = JSON.parse(envelopeText) as Envelope;
  if (env.r !== 1) throw new Error("not a ratcheted envelope (r !== 1)");

  const hasExistingSession = await hasSession(conversationId, peerUserId);
  if (!hasExistingSession) {
    if (env.t !== 0) {
      throw new Error("no session and message is not a prekey message (t !== 0)");
    }
    // Fetch peer bundle to get their Curve25519 identity for session creation.
    // Note: fetching the bundle here consumes one of the peer's OTKs — that is
    // expected; the server's atomic pop is idempotent if we already consumed one.
    const res = await fetch(`/api/user/keys/bundle?userId=${peerUserId}`);
    if (!res.ok) {
      throw new Error(`could not fetch peer bundle for inbound session: ${res.status}`);
    }
    const bundle = (await res.json()) as { olmIdentityCurve25519: string; olmIdentityEd25519?: string };
    await openInboundSession(
      conversationId,
      peerUserId,
      bundle.olmIdentityCurve25519,
      env.b,
      bundle.olmIdentityEd25519 ?? "",
    );
    if (!(await hasSession(conversationId, peerUserId))) {
      throw new Error("inbound session establishment failed");
    }
  }

  return useSession(conversationId, peerUserId, async (session) => {
    return session.decrypt(env.t, env.b);
  });
}

// ── Identity fingerprint ──────────────────────────────────────────────────────

/**
 * Returns the local user's Olm identity keys.
 * Useful for the "Verify identity" / safety-number UI — show these next to the
 * peer's identity keys (from their bundle) for out-of-band comparison.
 */
export async function myIdentityKeys(): Promise<IdentityKeys> {
  const { curve25519, ed25519 } = await getMyIdentityKeys();
  return { curve25519, ed25519 };
}

/**
 * Returns the stored Ed25519 identity key of the peer for a given session,
 * or null if the session does not exist or the key was not recorded.
 */
export async function getPeerEd25519(
  conversationId: string,
  peerUserId: string,
): Promise<string | null> {
  const stored = await idbGet<StoredSession>(sessionKey(conversationId, peerUserId));
  return stored?.peerIdentityEd25519 || null;
}
