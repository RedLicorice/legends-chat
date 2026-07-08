import { cacheClient } from "./redis";

// Fixed-window limiter over Redis. INCR the key; set the TTL on the first hit
// so the window auto-expires. Returns true if the caller is OVER the limit.
// Mirrors apps/web/lib/rate-limit.ts (checkAndIncrement) — kept separate
// because the ws app has its own ioredis client and no Next dependency.
export async function isRateLimited(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const count = await cacheClient.incr(key);
  if (count === 1) await cacheClient.expire(key, windowSeconds);
  return count > limit;
}
