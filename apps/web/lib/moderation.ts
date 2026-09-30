import { and, eq, inArray } from "drizzle-orm";
import { topicMembers, topics, userBans, userDeviceChangeLog, userMutes } from "@legends/db/schema";
import { REDIS_CHANNELS, REDIS_KEYS } from "@legends/shared";
import { db } from "./db";
import { redis } from "./redis";
import { revokeUserJtis } from "./auth-revoke";
import { publishTopicMembersUpdated } from "./topic-events";
import { AUDIT_ACTIONS, logAdminAction } from "./audit-log";

/**
 * cr-m9: a ban used to revoke sessions and nothing else. The banned account
 * stayed in `topic_members`, so `listTopicCryptoMembers` kept returning them and
 * every honest member kept wrapping the NEW Megolm key for their devices on
 * every rotation and membership change. Banning for account compromise stopped
 * the attacker posting but never stopped them reading.
 *
 * On ban we now drop their `topic_members` rows for E2EE topics, log the device
 * change, and publish TOPIC_MEMBERS_UPDATED per topic so connected clients run
 * onMembershipChange -> invalidateGroupSession -> reshare to the reduced set.
 *
 * Scoped to `is_e2ee` topics on purpose: plain topics have server-side read
 * control, and silently emptying a banned user's whole membership list would
 * destroy state an unban can't restore.
 */
async function revokeE2eeTopicMembership(userId: string): Promise<void> {
  const rows = await db
    .select({ topicId: topicMembers.topicId })
    .from(topicMembers)
    .innerJoin(topics, eq(topics.id, topicMembers.topicId))
    .where(and(eq(topicMembers.userId, userId), eq(topics.isE2ee, true)));
  if (rows.length === 0) return;

  const topicIds = rows.map((r) => r.topicId);
  await db
    .delete(topicMembers)
    .where(and(eq(topicMembers.userId, userId), inArray(topicMembers.topicId, topicIds)));

  // Peers must re-query this account's device list; without it their cached
  // device set keeps the banned user's devices as valid session targets.
  try {
    await db.insert(userDeviceChangeLog).values({ userId, reason: "topic_leave" });
  } catch { /* best-effort, mirrors logDeviceChange */ }

  for (const topicId of topicIds) {
    try {
      await publishTopicMembersUpdated({
        topicId,
        action: "leave",
        affectedUserId: userId,
      });
    } catch { /* a missed publish is picked up on the next refreshRoomMembers */ }
  }
}

export async function banUser(args: {
  userId: string;
  bannedByUserId: string;
  reason: string;
  expiresAt: Date | null;
  sourceFlagId?: string | null;
}): Promise<void> {
  await db.insert(userBans).values({
    userId: args.userId,
    bannedByUserId: args.bannedByUserId,
    reason: args.reason,
    expiresAt: args.expiresAt,
    sourceFlagId: args.sourceFlagId ?? null,
  });
  await revokeUserJtis(args.userId);
  await redis.set(REDIS_KEYS.BAN_CACHE(args.userId), "1", "EX", 60);
  await revokeE2eeTopicMembership(args.userId);
  await redis.publish(REDIS_CHANNELS.USER_BANNED, JSON.stringify({ userId: args.userId }));
  await logAdminAction({
    actorUserId: args.bannedByUserId,
    action: AUDIT_ACTIONS.USER_BAN,
    targetType: "user",
    targetId: args.userId,
    metadata: {
      reason: args.reason,
      expiresAt: args.expiresAt?.toISOString() ?? null,
      sourceFlagId: args.sourceFlagId ?? null,
    },
  });
}

export async function liftBan(banId: string, liftedByUserId: string): Promise<void> {
  const now = new Date();
  const [row] = await db
    .update(userBans)
    .set({ liftedAt: now, liftedByUserId })
    .where(eq(userBans.id, banId))
    .returning({ userId: userBans.userId });
  if (!row) return;
  await redis.del(REDIS_KEYS.BAN_CACHE(row.userId));
  await logAdminAction({
    actorUserId: liftedByUserId,
    action: AUDIT_ACTIONS.USER_BAN_LIFT,
    targetType: "user",
    targetId: row.userId,
    metadata: { banId },
  });
}

export async function muteUser(args: {
  userId: string;
  mutedByUserId: string;
  reason: string;
  expiresAt: Date | null;
  sourceFlagId?: string | null;
}): Promise<void> {
  await db.insert(userMutes).values({
    userId: args.userId,
    mutedByUserId: args.mutedByUserId,
    reason: args.reason,
    expiresAt: args.expiresAt,
    sourceFlagId: args.sourceFlagId ?? null,
  });
  await redis.set(REDIS_KEYS.MUTE_CACHE(args.userId), "1", "EX", 60);
  await redis.publish(REDIS_CHANNELS.USER_MUTED, JSON.stringify({ userId: args.userId }));
  await logAdminAction({
    actorUserId: args.mutedByUserId,
    action: AUDIT_ACTIONS.USER_MUTE,
    targetType: "user",
    targetId: args.userId,
    metadata: {
      reason: args.reason,
      expiresAt: args.expiresAt?.toISOString() ?? null,
      sourceFlagId: args.sourceFlagId ?? null,
    },
  });
}
