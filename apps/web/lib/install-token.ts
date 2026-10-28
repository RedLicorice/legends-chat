import { createHash, timingSafeEqual } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { systemSettings, users } from "@legends/db/schema";
import { db } from "@/lib/db";

// The token is created only by `packages/db/src/install-unlock.ts` (CLI). The
// DB holds its sha256 + expiry; the raw token only ever appears in the URL the
// operator was shown.
const KEY = "install_token";

export const INSTALL_CHALLENGE_TTL = 300;
export const installChallengeKey = (hash: string) => `install:reg:${hash}`;

interface StoredToken {
  hash: string;
  expiresAt: number;
  force: boolean;
}

export type InstallCheck =
  | { ok: true; hash: string; stored: string }
  | { ok: false; status: number; error: string };

const INVALID: InstallCheck = { ok: false, status: 403, error: "Install link is invalid or has expired." };

export async function checkInstallToken(token: unknown): Promise<InstallCheck> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return INVALID;
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY)).limit(1);
  if (!row?.value) return INVALID;

  let stored: StoredToken;
  try {
    stored = JSON.parse(row.value) as StoredToken;
  } catch {
    return INVALID;
  }
  const given = createHash("sha256").update(token).digest();
  const want = Buffer.from(stored.hash ?? "", "hex");
  if (want.length !== given.length || !timingSafeEqual(given, want)) return INVALID;
  if (!(stored.expiresAt > Date.now())) return INVALID;

  if (!stored.force) {
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
    if (admin) return { ok: false, status: 409, error: "An admin already exists." };
  }
  return { ok: true, hash: stored.hash, stored: row.value };
}

/** Atomically burn the token that checkInstallToken just validated. False if it was already burned or replaced. */
export async function consumeInstallToken(stored: string): Promise<boolean> {
  const deleted = await db
    .delete(systemSettings)
    .where(and(eq(systemSettings.key, KEY), eq(systemSettings.value, stored)))
    .returning({ key: systemSettings.key });
  return deleted.length === 1;
}
