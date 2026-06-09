import { and, count, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  passkeyCredentials,
  principalPermissionOverrides,
  rolesPermissions,
  topicMembers,
  topicPrincipalGrants,
  topics,
  userBans,
  userMutes,
  users,
} from "@legends/db/schema";
import { db } from "./db";

// Prepared on hot path /api/me + every authed RSC + every /api/* route.
// Skips planner round-trip after first call per pg backend connection.
export const psUserById = db
  .select()
  .from(users)
  .where(eq(users.id, sql.placeholder("id")))
  .limit(1)
  .prepare("ps_user_by_id");

// Prepared: per-role permission set, joined with overrides to build CurrentUser.
// Same role string repeats forever; planner cache is a clear win.
export const psRolePermissions = db
  .select({ permission: rolesPermissions.permission })
  .from(rolesPermissions)
  .where(eq(rolesPermissions.role, sql.placeholder("role")))
  .prepare("ps_role_permissions");

// Prepared: per-principal allow/deny override list. Filtered to live rows by
// NOW() so we get the same plan across requests regardless of expiry counts.
export const psUserPermissionOverrides = db
  .select({
    permission: principalPermissionOverrides.permission,
    effect: principalPermissionOverrides.effect,
  })
  .from(principalPermissionOverrides)
  .where(
    and(
      eq(principalPermissionOverrides.principalType, "user"),
      eq(principalPermissionOverrides.principalId, sql.placeholder("principalId")),
      or(
        isNull(principalPermissionOverrides.expiresAt),
        gt(principalPermissionOverrides.expiresAt, sql`NOW()`),
      ),
    ),
  )
  .prepare("ps_user_permission_overrides");

// Prepared: most-recent active mute for a user. Hit by every /api/topic GET +
// every message:send/edit/react path through getUserMute.
export const psUserMute = db
  .select()
  .from(userMutes)
  .where(
    and(
      eq(userMutes.userId, sql.placeholder("userId")),
      isNull(userMutes.liftedAt),
      or(isNull(userMutes.expiresAt), gt(userMutes.expiresAt, sql`NOW()`)),
    ),
  )
  .orderBy(sql`${userMutes.createdAt} DESC`)
  .limit(1)
  .prepare("ps_user_mute");

// Prepared: SQL-side ban check (Redis miss path). Hit on every getCurrentUser
// + every refreshAccessCookie when the BAN_CACHE entry expires.
export const psUserBan = db
  .select({ id: userBans.id })
  .from(userBans)
  .where(
    and(
      eq(userBans.userId, sql.placeholder("userId")),
      isNull(userBans.liftedAt),
      or(isNull(userBans.expiresAt), gt(userBans.expiresAt, sql`NOW()`)),
    ),
  )
  .limit(1)
  .prepare("ps_user_ban");

// Prepared: topic-by-slug for /api/topic/[slug] GET. Always called with the
// slug from the URL — same query shape every request.
export const psTopicBySlug = db
  .select()
  .from(topics)
  .where(eq(topics.slug, sql.placeholder("slug")))
  .limit(1)
  .prepare("ps_topic_by_slug");

// Prepared: passkey count for /api/topic/[slug] (drives the "set up passkey"
// nudge in the topic header). Hit on every topic open.
export const psPasskeyCount = db
  .select({ n: count() })
  .from(passkeyCredentials)
  .where(eq(passkeyCredentials.userId, sql.placeholder("userId")))
  .prepare("ps_passkey_count");

// Prepared: topic member roster for /api/topics/[id]/members and the
// per-topic socket bootstrap (mirrored as ps_ws_topic_members in
// apps/ws/src/db-prepared.ts). Drives mention autocomplete + the members
// pane.
export const psTopicMembers = db
  .select({
    id: users.id,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    role: users.role,
    isAnon: users.isAnon,
    joinedAt: topicMembers.joinedAt,
  })
  .from(topicMembers)
  .innerJoin(users, eq(topicMembers.userId, users.id))
  .where(eq(topicMembers.topicId, sql.placeholder("topicId")))
  .orderBy(users.displayName)
  .prepare("ps_topic_members");

// Note: hashtag cloud is NOT prepared — the SQL uses `unnest()` over an
// array column with a group_by, which drizzle's prepared builder doesn't
// model. /api/topics/[id]/hashtags inlines the raw SQL; the WS topic
// bootstrap does the same. Single-row prepared lookup wouldn't pay off
// here vs. the unnest scan that dominates the cost anyway.

// Prepared: per-user topic grants for a single topic. Used by /api/topic/[slug]
// to compute canPost/canReply, and by ws message:send before insert.
export const psTopicUserGrants = db
  .select({
    action: topicPrincipalGrants.action,
    effect: topicPrincipalGrants.effect,
  })
  .from(topicPrincipalGrants)
  .where(
    and(
      eq(topicPrincipalGrants.topicId, sql.placeholder("topicId")),
      eq(topicPrincipalGrants.principalType, "user"),
      eq(topicPrincipalGrants.principalId, sql.placeholder("principalId")),
      or(
        isNull(topicPrincipalGrants.expiresAt),
        gt(topicPrincipalGrants.expiresAt, sql`NOW()`),
      ),
    ),
  )
  .prepare("ps_topic_user_grants");
