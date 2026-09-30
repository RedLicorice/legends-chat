// Single source of truth for envelope-encryption data keys (cr-l12).
//
// This logic used to be copy-pasted in four places (apps/ws/src/messages.ts,
// apps/web/lib/dm.ts, packages/db/src/system-messages.ts and
// apps/web/app/api/bot/v1/sendMessage/route.ts), each with the same
// read-then-insert race: on a fresh database two processes both see an empty
// `encryption_keys` table and both insert a key, after which they disagree
// about which one is "current". Each row records its own `key_id` so nothing
// becomes undecryptable, but the fleet silently ends up with two active keys.
//
// Two mechanisms close that race:
//   - a transactional advisory lock around the create path, with a re-check
//     inside the lock, so concurrent callers in *this* module serialize;
//   - a partial unique index on `(purpose) WHERE rotated_at IS NULL` (migration
//     0049) so a concurrent insert from any other code path fails loudly with a
//     unique violation instead of creating a second active key.
//
// It lives in @legends/db rather than @legends/crypto because @legends/db
// already depends on @legends/crypto — putting a DB-aware helper in the crypto
// package would make that a cycle.
//
// Selection semantics are deliberately unchanged from the copies it replaces
// (`ORDER BY created_at DESC LIMIT 1`), so existing rows keep resolving to
// exactly the same key. Historical rows always decrypt via `getDataKeyById`.

import { desc, eq, sql } from "drizzle-orm";
import { generateDataKey, unwrapKey, wrapKey } from "@legends/crypto";
import { encryptionKeys } from "./schema";
import { db as defaultDb, type DB } from "./client";

/**
 * Domain separation for at-rest keys. Topic + system messages keep `messages`
 * so existing rows are untouched; DMs get their own key so a compromise of one
 * corpus's key does not extend to the other.
 */
export type DataKeyPurpose = "messages" | "attachments" | "dm_messages";

export type DataKey = { id: string; data: Uint8Array };

// Advisory-lock namespace. Arbitrary but fixed — pg_advisory_xact_lock takes
// two int4s, so the first identifies "this subsystem".
const ADVISORY_LOCK_NAMESPACE = 0x1e6e_d5_00 | 0;

const PURPOSE_LOCK_ID: Record<DataKeyPurpose, number> = {
  messages: 1,
  attachments: 2,
  dm_messages: 3,
};

// Process-local caches. `currentCache` is the hot path for writes;
// `byIdCache` serves reads of historical rows. Both are unbounded in principle
// but bounded in practice by the number of keys that have ever existed.
const currentCache = new Map<DataKeyPurpose, DataKey>();
const byIdCache = new Map<string, Uint8Array>();

/** Drop the in-process caches. Call after rotating a key out of band. */
export function resetDataKeyCache(): void {
  currentCache.clear();
  byIdCache.clear();
}

type Executor = Pick<DB, "select" | "insert" | "execute">;

async function selectCurrent(ex: Executor, purpose: DataKeyPurpose): Promise<DataKey | null> {
  const rows = await ex
    .select({ id: encryptionKeys.id, wrappedKey: encryptionKeys.wrappedKey })
    .from(encryptionKeys)
    .where(eq(encryptionKeys.purpose, purpose))
    .orderBy(desc(encryptionKeys.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, data: unwrapKey(row.wrappedKey) };
}

/**
 * The key new ciphertext should be written under. Creates one on first use,
 * serialized so a cold fleet can't produce two.
 */
export async function currentDataKey(
  purpose: DataKeyPurpose = "messages",
  dbInstance: DB = defaultDb,
): Promise<DataKey> {
  const hit = currentCache.get(purpose);
  if (hit) return hit;

  const existing = await selectCurrent(dbInstance, purpose);
  if (existing) {
    currentCache.set(purpose, existing);
    byIdCache.set(existing.id, existing.data);
    return existing;
  }

  const created = await dbInstance.transaction(async (tx) => {
    // Held until the transaction ends; the re-check below runs while we own it.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}, ${PURPOSE_LOCK_ID[purpose]})`,
    );
    const again = await selectCurrent(tx as unknown as Executor, purpose);
    if (again) return again;
    const data = generateDataKey();
    const { wrapped } = wrapKey(data);
    const [inserted] = await tx
      .insert(encryptionKeys)
      .values({ purpose, wrappedKey: wrapped })
      .returning({ id: encryptionKeys.id });
    return { id: inserted!.id, data } satisfies DataKey;
  });

  currentCache.set(purpose, created);
  byIdCache.set(created.id, created.data);
  return created;
}

/** Unwrapped key for a specific row's `key_id`. Never falls back to "current". */
export async function getDataKeyById(keyId: string, dbInstance: DB = defaultDb): Promise<Uint8Array> {
  const hit = byIdCache.get(keyId);
  if (hit) return hit;
  const [row] = await dbInstance
    .select({ wrappedKey: encryptionKeys.wrappedKey })
    .from(encryptionKeys)
    .where(eq(encryptionKeys.id, keyId))
    .limit(1);
  if (!row) throw new Error(`encryption key ${keyId} not found`);
  const data = unwrapKey(row.wrappedKey);
  byIdCache.set(keyId, data);
  return data;
}
