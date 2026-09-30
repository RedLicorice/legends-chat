// Append-only record of privileged mutations (cr-m10).
//
// `audit_log` has been a real table since migration 0000 with ZERO writers.
// What the admin UI calls an "audit log" is /api/admin/users/[id]/activity,
// assembled at read time from live sessions / user_bans / user_mutes /
// topic_members / messages rows. That projection has three problems the table
// fixes: it surfaces no actor (user_bans.banned_by_user_id is stored but never
// selected), it has no representation at all for message deletion, and it is a
// view over mutable rows — any admin with UPDATE/DELETE on those tables edits
// "history" directly.
//
// Every privileged mutation should call `logAdminAction`. Writes are
// best-effort: an audit failure must never abort the action being audited (a
// half-applied ban is worse than a missing log line), but it is always logged
// loudly so a silently broken audit trail is visible in the app logs.

import { auditLog } from "@legends/db/schema";
import { createLogger } from "@legends/shared";
import { db } from "@/lib/db";

const log = createLogger("audit-log");

/**
 * Canonical action names. Kept as a const map rather than a DB enum so adding
 * one is a code change with no migration, but centralised so the strings don't
 * drift between call sites.
 */
export const AUDIT_ACTIONS = {
  USER_BAN: "user.ban",
  USER_BAN_LIFT: "user.ban.lift",
  USER_MUTE: "user.mute",
  USER_MUTE_LIFT: "user.mute.lift",
  USER_ROLE_CHANGE: "user.role.change",
  USER_PERMISSION_CHANGE: "user.permission.change",
  MESSAGE_DELETE: "message.delete",
  MESSAGE_BULK_DELETE: "message.bulk_delete",
  SETTINGS_UPDATE: "settings.update",
  INVITE_CREATE: "invite.create",
  TOPIC_UPDATE: "topic.update",
  TOPIC_DELETE: "topic.delete",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export async function logAdminAction(args: {
  /** The acting principal, or null for a system/bot actor (see `metadata`). */
  actorUserId: string | null;
  action: AuditAction | (string & {});
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorUserId: args.actorUserId,
      action: args.action,
      targetType: args.targetType ?? null,
      targetId: args.targetId ?? null,
      metadata: args.metadata ?? null,
    });
  } catch (err) {
    log.error("insert failed", {
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      err,
    });
  }
}
