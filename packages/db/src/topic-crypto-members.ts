// Single source of truth for the E2EE "crypto member set" of a topic
// (cr-m8, cr-l15). This used to be copy-pasted in apps/web/lib/topic-members.ts
// and apps/ws/src/messages.ts; the apps/ws copy had no role-expiry filter, so
// a lapsed temporary admin kept receiving every live Megolm key rotation
// pushed over the WS channel even though the HTTP route already excluded
// them. See packages/db/src/maintenance.ts `sweepExpiredRoles` for the other
// half of the fix (the scheduled reconciler) — the filter here is what makes
// a missed sweep fail closed.
//
//   member_user_ids → topic_members rows for this topic
//   admin_user_ids  → role=admin, !isAnon, has ≥1 userKeyBundle, and whose
//                     role grant has NOT expired (only for is_e2ee topics;
//                     plain topics return [] for parity with the route)
//
// Bots are excluded — bots cannot participate in Plan D E2EE rooms.

import { and, eq, gt, isNull, or } from "drizzle-orm";
import { topicMembers, topics, userKeyBundles, users } from "./schema";
import { db as defaultDb, type DB } from "./client";

export interface TopicCryptoMembers {
  memberUserIds: string[];
  adminUserIds: string[];
}

export async function listTopicCryptoMembers(
  topicId: string,
  dbInstance: DB = defaultDb,
): Promise<TopicCryptoMembers | null> {
  const [topic] = await dbInstance
    .select({ id: topics.id, isE2ee: topics.isE2ee })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1);
  if (!topic) return null;

  const memberRows = await dbInstance
    .select({ userId: topicMembers.userId })
    .from(topicMembers)
    .where(eq(topicMembers.topicId, topic.id));
  const memberUserIds = memberRows.map((r) => r.userId).sort();

  let adminUserIds: string[] = [];
  if (topic.isE2ee) {
    const adminRows = await dbInstance
      .select({ id: users.id })
      .from(users)
      .innerJoin(userKeyBundles, eq(userKeyBundles.userId, users.id))
      .where(
        and(
          eq(users.role, "admin"),
          eq(users.isAnon, false),
          // Temporary grant still live, or no expiry at all.
          or(isNull(users.roleExpiresAt), gt(users.roleExpiresAt, new Date())),
        ),
      )
      .groupBy(users.id);
    adminUserIds = adminRows.map((r) => r.id).sort();
  }

  return { memberUserIds, adminUserIds };
}
