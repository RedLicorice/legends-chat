import { redis } from "@/lib/redis";

// Thin Redis memoizer. `loader` runs on cache miss; the result is stored
// under `key` with `ttlSeconds`. Negative/zero results from `loader` cache
// the same way (don't repeat expensive lookups for known-empty data) —
// callers that want to skip caching null must invalidate explicitly.
//
// On any Redis error (set or get), we fall back to executing the loader
// uncached so a flaky Redis never breaks the request.
export async function redisMemo<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  try {
    const cached = await redis.get(key);
    if (cached !== null) return JSON.parse(cached) as T;
  } catch { /* fall through to loader */ }
  const value = await loader();
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch { /* swallow */ }
  return value;
}

export async function redisInvalidate(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch { /* swallow */ }
}
