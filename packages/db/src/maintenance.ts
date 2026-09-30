// Scheduled maintenance sweeps.
//
// These exist because several invariants in this codebase were only enforced
// *lazily* — on the next request from the very principal they constrain, which
// an inactive principal never makes. Run from `scripts/sweep.ts` (cron /
// systemd timer); see that file for the operator-facing entry point.

import { and, eq, gte, inArray, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import { decryptMessage } from "@legends/crypto";
import {
  bots,
  customGifs,
  dmMessages,
  messageEdits,
  messages,
  systemSettings,
  topics,
  uploads,
  userDeviceChangeLog,
  users,
} from "./schema";
import { db as defaultDb, type DB } from "./client";
import { getDataKeyById } from "./data-keys";

// ── Expired temporary roles (cr-m8, cr-l15) ──────────────────────────────────
//
// Role expiry was enforced only in `checkAndRevertExpiredRole` (apps/web) and
// `getBotFromRequest` (apps/web/lib/bot-auth.ts) — i.e. only when the expiring
// principal itself makes a request. A 7-day admin grant issued for an incident
// therefore stayed `role='admin'` forever if the grantee never logged in again,
// and `listTopicCryptoMembers` kept returning them in `admin_user_ids`, so every
// sender kept wrapping fresh Megolm sessions for their devices months later.
//
// This is the reconciler that closes that gap. `listTopicCryptoMembers` also
// filters expired rows directly, so a missed sweep fails closed rather than
// leaving a former admin as a permanent E2EE recipient.

export interface RoleRevert {
  id: string;
  from: string;
  to: string;
}

export interface RoleSweepResult {
  users: RoleRevert[];
  bots: RoleRevert[];
}

export async function sweepExpiredRoles(
  opts: { dryRun?: boolean } = {},
  dbInstance: DB = defaultDb,
): Promise<RoleSweepResult> {
  const now = new Date();
  const result: RoleSweepResult = { users: [], bots: [] };

  const expiredUsers = await dbInstance
    .select({ id: users.id, role: users.role, fallback: users.roleFallback })
    .from(users)
    .where(and(isNotNull(users.roleExpiresAt), lte(users.roleExpiresAt, now)));

  for (const u of expiredUsers) {
    const to = u.fallback ?? "user";
    result.users.push({ id: u.id, from: u.role, to });
    if (opts.dryRun) continue;
    await dbInstance
      .update(users)
      .set({ role: to, roleExpiresAt: null, roleFallback: null })
      .where(eq(users.id, u.id));
    if (u.role === "admin" && to !== "admin") {
      // Tell peers to re-query this account's device list so they stop
      // treating it as a Megolm recipient. Best-effort, like logDeviceChange.
      try {
        await dbInstance
          .insert(userDeviceChangeLog)
          .values({ userId: u.id, reason: "admin_revoke" });
      } catch {
        // a missed log only delays peers noticing; the recipient query
        // already excludes expired rows.
      }
    }
  }

  // cr-l15: identical lazy-enforcement shape on bots (lib/bot-auth.ts). Bots
  // can't join Megolm topic rooms, so there's no device-change log to write.
  const expiredBots = await dbInstance
    .select({ id: bots.id, role: bots.role, fallback: bots.roleFallback })
    .from(bots)
    .where(and(isNotNull(bots.roleExpiresAt), lte(bots.roleExpiresAt, now)));

  for (const b of expiredBots) {
    const to = b.fallback ?? "bot";
    result.bots.push({ id: b.id, from: b.role, to });
    if (opts.dryRun) continue;
    await dbInstance
      .update(bots)
      .set({ role: to, roleExpiresAt: null, roleFallback: null })
      .where(eq(bots.id, b.id));
  }

  return result;
}

// ── Orphaned uploads (cr-h5) ─────────────────────────────────────────────────
//
// Nothing ever deleted an upload when the message carrying it was deleted or
// auto-pruned, so the volume only grew. Attachments live *inside* the encrypted
// message body (`{"v":1,"t":...,"a":[...]}`), so "is this file still
// referenced?" can only be answered by decrypting the at-rest envelope — which
// the server can do for every non-E2EE row (E2EE topics reject attachments
// outright, so no reachable reference can hide in a Megolm envelope).
//
// The sweep is deliberately conservative:
//   - only files with an `uploads` ledger row are candidates, so anything
//     written before that table existed is never touched;
//   - only files older than the grace window, so an upload that is still
//     sitting in a composer draft survives;
//   - any decrypt or query failure aborts the whole sweep without deleting.

export interface OrphanSweepOptions {
  /** Only consider uploads older than this. Default 24 h. */
  graceMs?: number;
  /** Max candidates examined per run. Default 500. */
  batchSize?: number;
  /** Report what would be deleted without touching anything. */
  dryRun?: boolean;
  /** Called for each orphan; the caller owns filesystem access. */
  unlink?: (storagePath: string) => Promise<void>;
}

export interface OrphanSweepResult {
  candidates: number;
  orphans: number;
  reclaimedBytes: number;
  deleted: string[];
}

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

export async function sweepOrphanUploads(
  opts: OrphanSweepOptions = {},
  dbInstance: DB = defaultDb,
): Promise<OrphanSweepResult> {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const batchSize = opts.batchSize ?? 500;
  const cutoff = new Date(Date.now() - graceMs);

  const candidates = await dbInstance
    .select({
      id: uploads.id,
      url: uploads.url,
      storagePath: uploads.storagePath,
      sizeBytes: uploads.sizeBytes,
      createdAt: uploads.createdAt,
    })
    .from(uploads)
    .where(and(isNull(uploads.deletedAt), lte(uploads.createdAt, cutoff)))
    .orderBy(uploads.createdAt)
    .limit(batchSize);

  const empty: OrphanSweepResult = { candidates: 0, orphans: 0, reclaimedBytes: 0, deleted: [] };
  if (candidates.length === 0) return empty;

  const pending = new Map(candidates.map((c) => [c.url, c]));
  const urls = [...pending.keys()];

  // 1) Direct column references. These are cheap indexed lookups.
  const drop = (url: string | null | undefined) => {
    if (url) pending.delete(url);
  };
  for (const r of await dbInstance
    .select({ a: users.avatarUrl, b: users.bannerUrl })
    .from(users)
    .where(or(inArray(users.avatarUrl, urls), inArray(users.bannerUrl, urls)))) {
    drop(r.a); drop(r.b);
  }
  for (const r of await dbInstance
    .select({ a: topics.iconUrl, b: topics.bannerUrl })
    .from(topics)
    .where(or(inArray(topics.iconUrl, urls), inArray(topics.bannerUrl, urls)))) {
    drop(r.a); drop(r.b);
  }
  for (const r of await dbInstance
    .select({ a: bots.avatarUrl })
    .from(bots)
    .where(inArray(bots.avatarUrl, urls))) {
    drop(r.a);
  }
  for (const r of await dbInstance
    .select({ a: customGifs.url, b: customGifs.thumbnailUrl })
    .from(customGifs)
    .where(or(inArray(customGifs.url, urls), inArray(customGifs.thumbnailUrl, urls)))) {
    drop(r.a); drop(r.b);
  }
  // Branding lives in system_settings (community logo/banner, PWA icon…).
  for (const r of await dbInstance.select({ value: systemSettings.value }).from(systemSettings)) {
    drop(r.value);
  }
  if (pending.size === 0) return { ...empty, candidates: candidates.length };

  // 2) Encrypted message bodies. An upload can only be referenced by content
  //    written at-or-after it existed, so bound the scan by the oldest
  //    surviving candidate.
  const since = candidates.reduce<Date>(
    (min, c) => (c.createdAt < min ? c.createdAt : min),
    candidates[0]!.createdAt,
  );

  const scanText = (text: string) => {
    if (pending.size === 0) return;
    for (const url of [...pending.keys()]) {
      if (text.includes(url)) pending.delete(url);
    }
  };

  // Topic messages (non-deleted, non-E2EE: E2EE rows have an empty bytea body).
  const topicRows = await dbInstance
    .select({
      topicId: messages.topicId,
      keyId: messages.keyId,
      ciphertext: messages.contentCiphertext,
      nonce: messages.contentNonce,
    })
    .from(messages)
    .where(
      and(
        isNull(messages.deletedAt),
        gte(messages.createdAt, since),
        sql`octet_length(${messages.contentCiphertext}) > 0`,
      ),
    );
  for (const row of topicRows) {
    if (pending.size === 0) break;
    const key = await getDataKeyById(row.keyId, dbInstance);
    const aad = new TextEncoder().encode(row.topicId);
    scanText(decryptMessage(key, row.ciphertext, row.nonce, aad));
  }

  // Archived prior versions of edited messages — an attachment removed by an
  // edit is still reachable through the edit history.
  if (pending.size > 0) {
    const editRows = await dbInstance
      .select({
        topicId: messages.topicId,
        keyId: messageEdits.keyId,
        ciphertext: messageEdits.previousContent,
        nonce: messageEdits.previousNonce,
      })
      .from(messageEdits)
      .innerJoin(messages, eq(messages.id, messageEdits.messageId))
      .where(and(isNull(messages.deletedAt), gte(messageEdits.editedAt, since)));
    for (const row of editRows) {
      if (pending.size === 0) break;
      if (row.ciphertext.length === 0) continue;
      const key = await getDataKeyById(row.keyId, dbInstance);
      const aad = new TextEncoder().encode(row.topicId);
      scanText(decryptMessage(key, row.ciphertext, row.nonce, aad));
    }
  }

  // Direct messages.
  if (pending.size > 0) {
    const dmRows = await dbInstance
      .select({
        conversationId: dmMessages.conversationId,
        keyId: dmMessages.keyId,
        ciphertext: dmMessages.contentCiphertext,
        nonce: dmMessages.contentNonce,
      })
      .from(dmMessages)
      .where(
        and(
          isNull(dmMessages.deletedAt),
          gte(dmMessages.createdAt, since),
          sql`octet_length(${dmMessages.contentCiphertext}) > 0`,
        ),
      );
    for (const row of dmRows) {
      if (pending.size === 0) break;
      const key = await getDataKeyById(row.keyId, dbInstance);
      const aad = new TextEncoder().encode(row.conversationId);
      scanText(decryptMessage(key, row.ciphertext, row.nonce, aad));
    }
  }

  const orphans = [...pending.values()];
  const result: OrphanSweepResult = {
    candidates: candidates.length,
    orphans: orphans.length,
    reclaimedBytes: orphans.reduce((n, o) => n + Number(o.sizeBytes), 0),
    deleted: [],
  };
  if (opts.dryRun || orphans.length === 0) return result;

  for (const o of orphans) {
    if (opts.unlink) await opts.unlink(o.storagePath);
    result.deleted.push(o.storagePath);
  }
  await dbInstance
    .update(uploads)
    .set({ deletedAt: new Date() })
    .where(inArray(uploads.id, orphans.map((o) => o.id)));
  return result;
}
