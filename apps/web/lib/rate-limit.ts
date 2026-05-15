import { redis } from "./redis";

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number };

// INCR then EXPIRE-on-first-hit. If the key was new, INCR returns 1 and we set
// the TTL. Subsequent hits within the window inherit the TTL. Slight race on
// the very first call (two callers can both see 1) is fine — TTL just gets
// re-set to the same value.
export async function checkAndIncrement(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  const ttl = await redis.ttl(key);
  const effectiveTtl = ttl > 0 ? ttl : windowSeconds;
  const resetAt = Date.now() + effectiveTtl * 1000;
  if (count > limit) {
    return { allowed: false, remaining: 0, resetAt };
  }
  return { allowed: true, remaining: Math.max(0, limit - count), resetAt };
}
