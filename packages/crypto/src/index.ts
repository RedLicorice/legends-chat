import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "node:crypto";

const NONCE_LEN = 24;
const KEY_LEN = 32;

function loadMasterKey(): Uint8Array {
  const b64 = process.env.ENCRYPTION_MASTER_KEY;
  if (!b64) throw new Error("ENCRYPTION_MASTER_KEY not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(`ENCRYPTION_MASTER_KEY must decode to ${KEY_LEN} bytes (got ${key.length})`);
  }
  return new Uint8Array(key);
}

let cachedMasterKey: Uint8Array | null = null;
function masterKey(): Uint8Array {
  cachedMasterKey ??= loadMasterKey();
  return cachedMasterKey;
}

export function generateDataKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_LEN));
}

export function wrapKey(plain: Uint8Array): { wrapped: Uint8Array; nonce: Uint8Array } {
  const nonce = new Uint8Array(randomBytes(NONCE_LEN));
  const cipher = xchacha20poly1305(masterKey(), nonce);
  const ciphertext = cipher.encrypt(plain);
  const wrapped = new Uint8Array(nonce.length + ciphertext.length);
  wrapped.set(nonce, 0);
  wrapped.set(ciphertext, nonce.length);
  return { wrapped, nonce };
}

export function unwrapKey(wrapped: Uint8Array): Uint8Array {
  const nonce = wrapped.slice(0, NONCE_LEN);
  const ciphertext = wrapped.slice(NONCE_LEN);
  const cipher = xchacha20poly1305(masterKey(), nonce);
  return cipher.decrypt(ciphertext);
}

export function encryptMessage(
  dataKey: Uint8Array,
  plaintext: string,
  aad?: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = new Uint8Array(randomBytes(NONCE_LEN));
  const cipher = xchacha20poly1305(dataKey, nonce, aad);
  const ciphertext = cipher.encrypt(new TextEncoder().encode(plaintext));
  return { ciphertext, nonce };
}

export function decryptMessage(
  dataKey: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  aad?: Uint8Array,
): string {
  const cipher = xchacha20poly1305(dataKey, nonce, aad);
  const plain = cipher.decrypt(ciphertext);
  return new TextDecoder().decode(plain);
}

export function buildAad(parts: { messageId?: string | bigint; topicId: string; createdAt?: Date }): Uint8Array {
  const s = `${parts.topicId}|${parts.messageId ?? ""}|${parts.createdAt?.toISOString() ?? ""}`;
  return new TextEncoder().encode(s);
}
