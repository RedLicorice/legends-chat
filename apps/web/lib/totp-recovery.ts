import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { totpRecoveryCodes } from "@legends/db/schema";
import { db } from "@/lib/db";

// Same unambiguous alphabet the invite codes use — no 0/O/1/I, so a code read
// off paper can't be mistyped into a different valid code. 32 divides 256
// evenly, so modulo sampling from random bytes stays unbiased.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10; // 32^10 = 50 bits each
const GROUP = 5; // displayed as XXXXX-XXXXX
export const RECOVERY_CODE_COUNT = 10;

/** Strip formatting so "abcde-fghjk", "ABCDE FGHJK" and "ABCDEFGHJK" match. */
export function normalizeRecoveryCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Does this look like a recovery code rather than a 6-digit TOTP code? */
export function isRecoveryCodeShape(raw: string): boolean {
  const c = normalizeRecoveryCode(raw);
  if (c.length !== CODE_LENGTH) return false;
  for (const ch of c) if (!ALPHABET.includes(ch)) return false;
  return true;
}

// Unsalted SHA-256 is deliberate. These are 50-bit server-generated secrets,
// not user-chosen passwords: there is no dictionary to attack and no reuse
// across users to correlate, so a slow salted KDF would buy nothing while
// making every login attempt expensive. The digest is purely a lookup key.
function hashRecoveryCode(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

function generateOne(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

function format(code: string): string {
  return `${code.slice(0, GROUP)}-${code.slice(GROUP)}`;
}

/**
 * Replace a user's recovery codes with a fresh set and return the plaintext —
 * the ONLY time it exists outside the user's hands. Callers must surface it in
 * the same response and never persist it.
 */
export async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const plain = new Set<string>();
  while (plain.size < RECOVERY_CODE_COUNT) plain.add(generateOne());
  const codes = [...plain];

  await db.transaction(async (tx) => {
    await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId));
    await tx.insert(totpRecoveryCodes).values(
      codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })),
    );
  });

  return codes.map(format);
}

/**
 * Spend one recovery code. Returns false if it doesn't belong to this user or
 * has already been used.
 *
 * The conditional UPDATE ... WHERE used_at IS NULL RETURNING is what makes a
 * code single-use: two concurrent logins presenting the same code can't both
 * see it unused, because only one UPDATE can match the row.
 */
export async function redeemRecoveryCode(userId: string, raw: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(raw);
  if (!isRecoveryCodeShape(normalized)) return false;

  const spent = await db
    .update(totpRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(totpRecoveryCodes.userId, userId),
        eq(totpRecoveryCodes.codeHash, hashRecoveryCode(normalized)),
        isNull(totpRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: totpRecoveryCodes.id });

  return spent.length > 0;
}

/** How many unused codes the user has left, for the settings panel. */
export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(totpRecoveryCodes)
    .where(and(eq(totpRecoveryCodes.userId, userId), isNull(totpRecoveryCodes.usedAt)));
  return Number(row?.count ?? 0);
}
