import { getSetting as getSettingFromDb, type SystemSettingKey } from "@legends/db/system-settings";
import { db } from "@/lib/db";

// In-memory LRU-style cache for system_settings reads. Settings rarely change
// at runtime, so a short TTL keeps per-request DB hits down to a single round
// trip when the cache misses. Admin writes via `/api/admin/settings` must call
// `invalidateSetting` so the next read refreshes.
//
// Scoped to the Node process — restart picks up any out-of-band changes.

const TTL_MS = 60_000;

interface Entry {
  value: string | null;
  expiresAt: number;
}

const cache = new Map<SystemSettingKey, Entry>();

export async function getSettingCached(key: SystemSettingKey): Promise<string | null> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await getSettingFromDb(db, key);
  cache.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

export function invalidateSetting(key: SystemSettingKey): void {
  cache.delete(key);
}

export function invalidateAllSettings(): void {
  cache.clear();
}
