import { and, eq, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { passkeyCredentials, users } from "@legends/db/schema";
import { db } from "@/lib/db";

const ABANDON_AGE_MS = 30 * 60 * 1000; // 30 min

/**
 * Delete users created via the Telegram landing-page flow that never finished
 * passkey setup. Identified by: telegramUserId set, passwordHash null, no
 * passkey credentials, older than ABANDON_AGE_MS, no lastSeenAt activity.
 * Pre-existing passwordless accounts are NOT removed because they have either
 * a passwordHash, or a passkey, or lastSeenAt activity, or are not yet 30 min
 * old (in which case the next call gets them anyway — fine).
 *
 * Called lazily by /api/auth/landing-info — keeps the table tidy without
 * a scheduled job.
 */
export async function cleanupAbandonedRegistrations(): Promise<number> {
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
        sql`${users.lastSeenAt} IS NULL`,
      ),
    );

  if (candidates.length === 0) return 0;

  const ids = candidates.map((c) => c.id);
  await db.delete(users).where(sql`${users.id} = ANY(${ids})`);
  return ids.length;
}
