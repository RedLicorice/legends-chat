import { and, eq, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { passkeyCredentials, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getSetting } from "@legends/db/system-settings";

const ABANDON_AGE_MS = 30 * 60 * 1000; // 30 min

// Minimum gap between two real sweeps, enforced across replicas by a Redis key
// with a TTL. Its only caller is an unauthenticated public endpoint, so without
// this the work below ran once per request.
const SWEEP_INTERVAL_SECONDS = 300;
const SWEEP_LOCK_KEY = "registration-cleanup:lock";

// Ceiling on rows touched per sweep. Abandoned registrations trickle in, so a
// few hundred every five minutes drains any realistic backlog while keeping
// each statement's cost bounded and predictable.
const SWEEP_LIMIT = 500;

/**
 * Delete users created via the Telegram landing-page flow that never finished
 * passkey setup. Only runs when `require_passkey_at_registration` is on — in
 * that mode, a Telegram-registered user without a passkey >30 min after
 * creation is unambiguously abandoned (a completed registration would have a
 * passkey credential row). When the setting is off, every successful
 * registration issues a session immediately and has no passkey, so we cannot
 * distinguish abandoned from valid accounts — skip cleanup entirely.
 *
 * Called lazily by /api/auth/landing-info, which is public and unauthenticated.
 * That made the *unthrottled* version a DoS primitive: a loop of GETs ran an
 * unbounded users ⟕ passkey_credentials join plus a DELETE on every single
 * request, exhausting database CPU and taking down the whole app rather than
 * just registration. Two guards now apply — a Redis SET NX EX so at most one
 * sweep runs per SWEEP_INTERVAL_SECONDS no matter the request volume, and a
 * LIMIT on the candidate query.
 *
 * Returns the number of rows deleted, or 0 if this call was skipped.
 */
export async function cleanupAbandonedRegistrations(): Promise<number> {
  // Claim the interval first, before any database work. SET NX EX is atomic,
  // so exactly one caller across all replicas wins each window; everyone else
  // returns immediately having touched nothing.
  //
  // Deliberately not released on completion: this is a debounce, not a mutex.
  // If the sweep crashes we simply wait out the TTL and try again, which is
  // the failure mode we want for a best-effort janitor.
  let claimed: string | null = null;
  try {
    claimed = await redis.set(SWEEP_LOCK_KEY, "1", "EX", SWEEP_INTERVAL_SECONDS, "NX");
  } catch {
    // Redis unavailable: skip rather than fall back to running unthrottled.
    return 0;
  }
  if (claimed === null) return 0;

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
    )
    .limit(SWEEP_LIMIT);

  if (candidates.length === 0) return 0;

  const ids = candidates.map((c) => c.id);
  await db.delete(users).where(sql`${users.id} = ANY(${ids})`);
  return ids.length;
}
