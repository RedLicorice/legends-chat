// Browser-only E2EE using Web Crypto API (P-256 ECDH + AES-GCM + PBKDF2).
// Never import this in server-side code.

const DB_NAME = "legends-e2ee";
const DB_VERSION = 2;
const STORE = "keys";
const PIN_STORE = "pinned-keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // Create keys store if upgrading from scratch
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      // Create pinned-keys store (new in v2)
      if (!db.objectStoreNames.contains(PIN_STORE)) {
        db.createObjectStore(PIN_STORE);
      }
      // v1 → v2: clear all sender key records (format change: Uint8Array → {key, sessionId})
      if (event.oldVersion < 2 && event.oldVersion > 0) {
        const tx = req.transaction!;
        const store = tx.objectStore(STORE);
        const curReq = store.openCursor();
        curReq.onsuccess = () => {
          const cursor = curReq.result;
          if (!cursor) return;
          if ((cursor.key as string).startsWith("sk:")) cursor.delete();
          cursor.continue();
        };
        curReq.onerror = (e) => { console.error("[e2ee] v1→v2 migration cursor error", e); };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbPinGet(userId: string): Promise<{ fingerprint: string; pinnedAt: number } | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PIN_STORE, "readonly");
    const req = tx.objectStore(PIN_STORE).get(userId);
    req.onsuccess = () => resolve(req.result as { fingerprint: string; pinnedAt: number } | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPinSet(userId: string, fingerprint: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PIN_STORE, "readwrite");
    const req = tx.objectStore(PIN_STORE).put({ fingerprint, pinnedAt: Date.now() }, userId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// base64url (WebAuthn credential IDs) → Uint8Array
function fromB64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return fromB64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

const IDB_IDENTITY = "identity-kp";

export async function getOrCreateIdentityKeyPair(): Promise<CryptoKeyPair> {
  const stored = await idbGet<CryptoKeyPair>(IDB_IDENTITY);
  if (stored) return stored;
  const kp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );
  await idbSet(IDB_IDENTITY, kp);
  return kp;
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const buf = await crypto.subtle.exportKey("spki", key);
  return toB64(buf);
}

export async function importPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    fromB64(b64).buffer,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

async function deriveSharedKey(myPrivKey: CryptoKey, theirPubKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: theirPubKey },
    myPrivKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function generateSenderKey(): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(32);
  crypto.getRandomValues(new Uint8Array(buf));
  return new Uint8Array(buf);
}

export async function encryptSenderKeyForRecipient(
  senderKey: Uint8Array<ArrayBuffer>,
  myPrivKey: CryptoKey,
  recipientPubKey: CryptoKey,
): Promise<string> {
  const sharedKey = await deriveSharedKey(myPrivKey, recipientPubKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, senderKey);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return toB64(out);
}

export async function decryptSenderKey(
  encryptedKey: string,
  myPrivKey: CryptoKey,
  distributorPubKey: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const sharedKey = await deriveSharedKey(myPrivKey, distributorPubKey);
  const data = fromB64(encryptedKey);
  const iv = new Uint8Array(data.buffer, 0, 12);
  const ct = new Uint8Array(data.buffer, 12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sharedKey, ct);
  return new Uint8Array(plain);
}

const IDB_SENDER_KEY_PREFIX = "sk:";

export async function storeSenderKey(
  topicId: string,
  senderUserId: string,
  key: Uint8Array<ArrayBuffer>,
  sessionId: string = "", // "" when storing a received key (decrypt path); pass real session ID when storing own key
): Promise<void> {
  await idbSet(`${IDB_SENDER_KEY_PREFIX}${topicId}:${senderUserId}`, { key, sessionId });
}

export async function getSenderKey(
  topicId: string,
  senderUserId: string,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const record = await idbGet<{ key: Uint8Array<ArrayBuffer>; sessionId: string } | Uint8Array<ArrayBuffer>>(
    `${IDB_SENDER_KEY_PREFIX}${topicId}:${senderUserId}`,
  );
  if (!record) return undefined;
  // Handle legacy format (raw Uint8Array stored before v2 migration)
  if (record instanceof Uint8Array) return record;
  return record.key;
}

export async function getSenderKeySessionId(
  topicId: string,
  senderUserId: string,
): Promise<string | undefined> {
  const record = await idbGet<{ key: Uint8Array<ArrayBuffer>; sessionId: string } | Uint8Array<ArrayBuffer>>(
    `${IDB_SENDER_KEY_PREFIX}${topicId}:${senderUserId}`,
  );
  if (!record || record instanceof Uint8Array) return undefined;
  return record.sessionId;
}

export async function clearSenderKeysForTopic(topicId: string, userIds: string[]): Promise<void> {
  for (const uid of userIds) await idbDel(`${IDB_SENDER_KEY_PREFIX}${topicId}:${uid}`);
}

export async function clearAllSenderKeys(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      if ((cursor.key as string).startsWith(IDB_SENDER_KEY_PREFIX)) cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function generateNewIdentityKeyPair(): Promise<CryptoKeyPair> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );
  await idbSet(IDB_IDENTITY, kp);
  return kp;
}

export interface E2EEPayload {
  e: 1;
  kid: string;
  iv: string;
  ct: string;
}

export function isE2EEContent(text: string): boolean {
  try {
    const obj = JSON.parse(text) as unknown;
    return typeof obj === "object" && obj !== null && (obj as { e?: unknown }).e === 1;
  } catch {
    return false;
  }
}

export async function encryptE2EEMessage(plaintext: string, senderUserId: string, senderKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const keyObj = await crypto.subtle.importKey("raw", senderKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const encBuf = new Uint8Array(enc.buffer);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyObj, encBuf);
  const payload: E2EEPayload = { e: 1, kid: senderUserId, iv: toB64(iv), ct: toB64(ct) };
  return JSON.stringify(payload);
}

export async function decryptE2EEMessage(text: string, senderKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const { iv, ct } = JSON.parse(text) as E2EEPayload;
  const keyObj = await crypto.subtle.importKey("raw", senderKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, keyObj, fromB64(ct));
  return new TextDecoder().decode(plain);
}

// ── TOFU Key Pinning ──────────────────────────────────────────────────────────

export async function computeFingerprint(key: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", key);
  const hash = await crypto.subtle.digest("SHA-256", spki);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function checkAndUpdatePin(
  userId: string,
  key: CryptoKey,
): Promise<{ changed: boolean; oldFingerprint?: string; newFingerprint: string }> {
  const newFingerprint = await computeFingerprint(key);
  try {
    const existing = await idbPinGet(userId);
    if (!existing) {
      await idbPinSet(userId, newFingerprint);
      return { changed: false, newFingerprint };
    }
    if (existing.fingerprint === newFingerprint) {
      return { changed: false, newFingerprint };
    }
    // Mismatch — do NOT auto-update; caller must call confirmPinUpdate after user trusts
    return { changed: true, oldFingerprint: existing.fingerprint, newFingerprint };
  } catch {
    // IndexedDB unavailable — degrade silently
    return { changed: false, newFingerprint };
  }
}

export async function confirmPinUpdate(userId: string, fingerprint: string): Promise<void> {
  try {
    await idbPinSet(userId, fingerprint);
  } catch {
    // degrade silently
  }
}

export function formatFingerprintShort(fingerprint: string): string {
  return fingerprint.slice(0, 16).toUpperCase();
}

export function computeSafetyNumber(myFingerprintHex: string, theirFingerprintHex: string): string {
  // Concatenate in lexicographic order so both sides get the same number
  const sorted = [myFingerprintHex, theirFingerprintHex].sort();
  const combined = sorted[0]! + sorted[1]!;
  // Convert hex string to a large decimal, group into 12×5-digit blocks
  // We use BigInt for precision
  const num = BigInt("0x" + combined);
  // Keep least-significant 60 digits — sufficient for human verification (10^-60 collision probability)
  const str = num.toString(10).padStart(60, "0").slice(-60);
  return str.match(/.{5}/g)!.join(" ");
}

// ── PRF-based backup (WebAuthn PRF extension, Chrome 116+/Safari 17+) ──────────

interface PrfBackupPayload {
  type: "prf";
  credentialId: string;   // base64url — which passkey to use for unlock
  credentialName: string; // display name captured at backup time
  prfSalt: string;        // base64 — PRF eval input (stored so restore uses same input)
  iv: string;
  wrapped: string;
  pub: string;
}

export function getPrfCredentialName(backup: string): string | null {
  try { return (JSON.parse(backup) as { credentialName?: string }).credentialName ?? null; } catch { return null; }
}

async function prfAssert(credentialId: string, prfSalt: Uint8Array): Promise<ArrayBuffer> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: "public-key", id: fromB64Url(credentialId) }],
      userVerification: "required",
      extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential;
  const results = credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  const prfOutput = results.prf?.results?.first;
  if (!prfOutput) throw new Error("Passkey does not support the PRF extension. Use passphrase backup instead.");
  return prfOutput;
}

export async function exportIdentityBackupWithPrf(
  kp: CryptoKeyPair,
  credentialId: string,
  credentialName: string,
): Promise<string> {
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const prfOutput = await prfAssert(credentialId, prfSalt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey("raw", prfOutput, { name: "AES-GCM" }, false, ["encrypt"]);
  // Use explicit exportKey→encrypt rather than wrapKey — wrapKey has patchy
  // support for ECDH/pkcs8 on some Android WebViews despite extractable:true.
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, pkcs8);
  const pubBuf = await crypto.subtle.exportKey("spki", kp.publicKey);
  const payload: PrfBackupPayload = {
    type: "prf",
    credentialId,
    credentialName,
    prfSalt: toB64(prfSalt),
    iv: toB64(iv),
    wrapped: toB64(wrapped),
    pub: toB64(pubBuf),
  };
  return JSON.stringify(payload);
}

export async function importIdentityBackupWithPrf(backup: string): Promise<CryptoKeyPair> {
  const { credentialId, prfSalt, iv, wrapped, pub } = JSON.parse(backup) as PrfBackupPayload;
  const prfOutput = await prfAssert(credentialId, fromB64(prfSalt));
  const aesKey = await crypto.subtle.importKey("raw", prfOutput, { name: "AES-GCM" }, false, ["decrypt"]);
  const pkcs8 = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, aesKey, fromB64(wrapped));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"],
  );
  const publicKey = await crypto.subtle.importKey("spki", fromB64(pub).buffer, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const kp = { privateKey, publicKey };
  await idbSet(IDB_IDENTITY, kp);
  return kp;
}
