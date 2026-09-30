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

// cr-m7: `buildAad({ topicId, messageId, createdAt })` used to live here with
// ZERO call sites, which made the envelope look like it bound message identity
// when it does not. Every real caller passes only the scope id as AAD:
//
//     const aad = new TextEncoder().encode(topicId);        // topic messages
//     const aad = new TextEncoder().encode(conversationId); // DMs
//
// So what the AEAD actually authenticates is "this ciphertext belongs to this
// topic/conversation" — NOT which row, which sender, or when. Anyone with
// direct DB write access can relocate a (content_ciphertext, content_nonce,
// key_id) triple to another row in the same topic and it decrypts and
// authenticates perfectly under a different sender and timestamp.
//
// The helper is deleted rather than adopted because adopting it is not a
// crypto-package change: it needs a versioned AAD (so existing rows keep
// decrypting under the narrower v1 binding) applied at every write and read
// site, and `messages.id` is a bigserial that doesn't exist until after the
// INSERT — so binding it needs a two-phase write or a pre-allocated sequence
// value in each path. Leaving dead code that implies the binding exists is
// strictly worse than being explicit that it doesn't.
