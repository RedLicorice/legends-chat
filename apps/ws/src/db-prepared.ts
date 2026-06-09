import { and, asc, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  messageFlags,
  notifications,
  passkeyCredentials,
  symbols,
  systemSettings,
  topicMembers,
  topicPrincipalGrants,
  topics,
  userMutes,
  users,
} from "@legends/db/schema";
import { db } from "./db";

// Prepared queries used by the per-socket bootstrap path. Same intent as
// apps/web/lib/db-prepared.ts but bound to the WS app's pg pool — drizzle
// prepares are per-connection, so each process needs its own copies.

export const psTopicBySlug = db
  .select()
  .from(topics)
  .where(eq(topics.slug, sql.placeholder("slug")))
  .limit(1)
  .prepare("ps_ws_topic_by_slug");

export const psTopicById = db
  .select()
  .from(topics)
  .where(eq(topics.id, sql.placeholder("id")))
  .limit(1)
  .prepare("ps_ws_topic_by_id");

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
  .prepare("ps_ws_topic_user_grants");

export const psPasskeyCount = db
  .select({ n: count() })
  .from(passkeyCredentials)
  .where(eq(passkeyCredentials.userId, sql.placeholder("userId")))
  .prepare("ps_ws_passkey_count");

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
  .prepare("ps_ws_user_mute");

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
  .prepare("ps_ws_topic_members");

export const psSymbols = db
  .select({
    id: symbols.id,
    symbol: symbols.symbol,
    name: symbols.name,
    description: symbols.description,
    linkedUserId: symbols.linkedUserId,
    linkedUserDisplayName: users.displayName,
    linkedUserAvatarUrl: users.avatarUrl,
  })
  .from(symbols)
  .leftJoin(users, eq(symbols.linkedUserId, users.id))
  .orderBy(asc(symbols.symbol))
  .prepare("ps_ws_symbols");

export const psRecentNotifications = db
  .select()
  .from(notifications)
  .where(eq(notifications.userId, sql.placeholder("userId")))
  .orderBy(desc(notifications.createdAt))
  .limit(50)
  .prepare("ps_ws_recent_notifications");

export const psSystemSetting = db
  .select({ value: systemSettings.value })
  .from(systemSettings)
  .where(eq(systemSettings.key, sql.placeholder("key")))
  .limit(1)
  .prepare("ps_ws_system_setting");

export const psPendingFlagCount = db
  .select({ n: count() })
  .from(messageFlags)
  .where(eq(messageFlags.status, "pending"))
  .prepare("ps_ws_pending_flag_count");
