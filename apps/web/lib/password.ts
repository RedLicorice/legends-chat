import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Stored format: scrypt$N$r$p$salt$hash
//
// The cost parameters are part of the record. The old format was
// `scrypt:<salt>:<hash>` with no parameters, which meant every hash was
// implicitly pinned to whatever defaults the running Node happened to use
// (N=2^14) and N could never be raised without invalidating every password in
// the database. Encoding N/r/p lets old records keep verifying against their
// own parameters while new ones use the current target, and lets the target be
// raised again later the same way. `needsRehash` + the login route upgrade
// records transparently as people sign in.
//
// N=2^17 with r=8, p=1 is OWASP's current scrypt recommendation (~128 MiB per
// hash, ~100-200 ms). `maxmem` has to be passed explicitly: Node's default
// 32 MiB ceiling rejects anything above about N=2^15.
//
// That memory is per in-flight hash, so the login/register rate limiters are
// load-bearing here, not just anti-guessing. If this ever needs to run on a
// small box, N=2^16 is the next step down (~64 MiB) — and thanks to the
// parameterised format, changing these constants is now safe: existing records
// keep verifying with their own values.
const SCRYPT_N = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

// scrypt needs 128 * N * r bytes; give it headroom.
function maxmemFor(N: number, r: number): number {
  return 256 * N * r;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: string;
  hashHex: string;
}

// Accepts both current `scrypt$N$r$p$salt$hash` records and legacy
// `scrypt:salt:hash` ones, which are by definition Node's old defaults.
function parseStored(stored: string): ParsedHash | null {
  if (stored.startsWith("scrypt$")) {
    const parts = stored.split("$");
    if (parts.length !== 6) return null;
    const [, nRaw, rRaw, pRaw, salt, hashHex] = parts;
    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
    if (N < 2 || r < 1 || p < 1) return null;
    // Refuse absurd parameters from a corrupted or tampered record rather than
    // letting one login turn into memory exhaustion.
    if (N > 1 << 22 || r > 32 || p > 16) return null;
    if (!salt || !hashHex) return null;
    return { N, r, p, salt, hashHex };
  }

  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return null;
  const [, salt, hashHex] = parts;
  if (!salt || !hashHex) return null;
  return { N: 1 << 14, r: 8, p: 1, salt, hashHex };
}

function derive(password: string, salt: string, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N, r, p, maxmem: maxmemFor(N, r) },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const hash = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  try {
    const derived = await derive(password, parsed.salt, parsed.N, parsed.r, parsed.p);
    return timingSafeEqual(derived, Buffer.from(parsed.hashHex, "hex"));
  } catch {
    // Length mismatch, bad hex, or a scrypt failure — all mean "no".
    return false;
  }
}

/**
 * Should this record be re-hashed with the current parameters the next time we
 * hold the plaintext? True for legacy unparameterised records and for anything
 * weaker than today's target.
 */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parsed = parseStored(stored);
  if (!parsed) return false;
  return parsed.N < SCRYPT_N || parsed.r < SCRYPT_R || parsed.p < SCRYPT_P;
}
