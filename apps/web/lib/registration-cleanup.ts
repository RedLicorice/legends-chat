import { and, eq, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { passkeyCredentials, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getSetting } from "@legends/db/system-settings";

const ABANDON_AGE_MS = 30 * 60 * 1000; // 30 min

/**
 * Delete users created via the Telegram landing-page flow that never finished
 * passkey setup. Only runs when `require_passkey_at_registration` is on — in
 * that mode, a Telegram-registered user without a passkey >30 min after
 * creation is unambiguously abandoned (a completed registration would have a
 * passkey credential row). When the setting is off, every successful
 * registration issues a session immediately and has no passkey, so we cannot
 * distinguish abandoned from valid accounts — skip cleanup entirely.
 *
 * Called lazily by /api/auth/landing-info.
 */
export async function cleanupAbandonedRegistrations(): Promise<number> {
  const requirePasskey = (await getSetting(db, "require_passkey_at_registration")) === "true";
  if (!requirePasskey) return 0;

  const cutoff = new Date(Date.now() - ABANDON_AGE_MS);

  const candidates = await db
    .select({ id: users.id })
    .from(users)
    .leftJoin(passkeyCredentials, eq(passkeyCredentials.userId, users.id))
    .where(
      and(
        isNotNull(users.telegramUserId),
        isNull(users.passwordHash),
        isNull(passkeyCredentials.id),
        lt(users.createdAt, cutoff),
      ),
    );

  if (candidates.length === 0) return 0;

  const ids = candidates.map((c) => c.id);
  await db.delete(users).where(sql`${users.id} = ANY(${ids})`);
  return ids.length;
}
