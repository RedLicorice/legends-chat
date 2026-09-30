import { createLogger } from "@legends/shared";
import { pubClient } from "./redis";

const log = createLogger("bot:invite-attempts");

// Wrong invite codes a single Telegram account may try per window before the
// prompt is closed on them.
export const INVITE_MAX_ATTEMPTS = 5;
export const INVITE_ATTEMPT_WINDOW_SECONDS = 3600;

// The counter deliberately lives in Redis, NOT in grammY's session. `session()`
// in index.ts has no storage adapter, so sessions are in-memory: they're lost
// on every bot restart and aren't shared across replicas, which makes them
// useless as a security counter. Redis is already a hard dependency of this
// process (token-lifecycle subscribes to it), so this adds no new one.
//
// `pubClient` — NOT `subClient`, which is in subscriber mode and can't run
// ordinary commands.
function key(telegramUserId: bigint): string {
  return `bot:invite-attempts:${telegramUserId.toString()}`;
}

export interface AttemptState {
  /** Attempts used in the current window, including this one. */
  used: number;
  /** True once the caller has spent its allowance — stop answering. */
  lockedOut: boolean;
  /** Seconds until the window resets (best-effort, for the user-facing copy). */
  retryAfterSeconds: number;
}

/**
 * Record one wrong invite-code guess and report whether this Telegram account
 * is now locked out.
 *
 * Fails CLOSED: if Redis is unreachable we report a lockout rather than
 * allowing unlimited guesses, matching the web app's rate limiter. The bot
 * can't function meaningfully without Redis anyway.
 */
export async function recordFailedInviteAttempt(telegramUserId: bigint): Promise<AttemptState> {
  const k = key(telegramUserId);
  try {
    const used = await pubClient.incr(k);
    if (used === 1) {
      await pubClient.expire(k, INVITE_ATTEMPT_WINDOW_SECONDS);
    }
    const ttl = await pubClient.ttl(k);
    return {
      used,
      lockedOut: used >= INVITE_MAX_ATTEMPTS,
      retryAfterSeconds: ttl > 0 ? ttl : INVITE_ATTEMPT_WINDOW_SECONDS,
    };
  } catch (err) {
    log.error("redis unavailable — failing closed", err);
    return {
      used: INVITE_MAX_ATTEMPTS,
      lockedOut: true,
      retryAfterSeconds: INVITE_ATTEMPT_WINDOW_SECONDS,
    };
  }
}

/** Is this account already locked out (checked before we even look the code up)? */
export async function isInviteLockedOut(telegramUserId: bigint): Promise<boolean> {
  try {
    const raw = await pubClient.get(key(telegramUserId));
    return raw !== null && Number(raw) >= INVITE_MAX_ATTEMPTS;
  } catch (err) {
    log.error("redis unavailable — failing closed", err);
    return true;
  }
}

/** Wipe the counter after a successful redemption so a real user isn't punished. */
export async function clearInviteAttempts(telegramUserId: bigint): Promise<void> {
  try {
    await pubClient.del(key(telegramUserId));
  } catch {
    // Best-effort: the key expires on its own.
  }
}
