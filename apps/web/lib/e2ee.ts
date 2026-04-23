// Browser-only E2EE using Web Crypto API (P-256 ECDH + AES-GCM + PBKDF2).
// Never import this in server-side code.

const DB_NAME = "legends-e2ee";
const DB_VERSION = 1;
const STORE = "keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
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
    false,
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

export async function storeSenderKey(topicId: string, senderUserId: string, key: Uint8Array<ArrayBuffer>): Promise<void> {
  await idbSet(`${IDB_SENDER_KEY_PREFIX}${topicId}:${senderUserId}`, key);
}

export async function getSenderKey(topicId: string, senderUserId: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return idbGet<Uint8Array<ArrayBuffer>>(`${IDB_SENDER_KEY_PREFIX}${topicId}:${senderUserId}`);
}

export async function clearSenderKeysForTopic(topicId: string, userIds: string[]): Promise<void> {
  for (const uid of userIds) await idbDel(`${IDB_SENDER_KEY_PREFIX}${topicId}:${uid}`);
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

export async function exportIdentityBackup(kp: CryptoKeyPair, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ppKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
    ppKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey"],
  );
  const wrapped = await crypto.subtle.wrapKey("pkcs8", kp.privateKey, wrapKey, { name: "AES-GCM", iv });
  const pubBuf = await crypto.subtle.exportKey("spki", kp.publicKey);
  return JSON.stringify({ salt: toB64(salt), iv: toB64(iv), wrapped: toB64(wrapped), pub: toB64(pubBuf) });
}

export async function importIdentityBackup(backup: string, passphrase: string): Promise<CryptoKeyPair> {
  const { salt, iv, wrapped, pub } = JSON.parse(backup) as { salt: string; iv: string; wrapped: string; pub: string };
  const ppKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const unwrapKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: fromB64(salt), iterations: 200000, hash: "SHA-256" },
    ppKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["unwrapKey"],
  );
  const privateKey = await crypto.subtle.unwrapKey(
    "pkcs8",
    fromB64(wrapped),
    unwrapKey,
    { name: "AES-GCM", iv: fromB64(iv) },
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );
  const publicKey = await crypto.subtle.importKey("spki", fromB64(pub).buffer, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const kp = { privateKey, publicKey };
  await idbSet(IDB_IDENTITY, kp);
  return kp;
}
