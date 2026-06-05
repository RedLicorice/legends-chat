// Resolves the crypto-member set for an E2EE topic.
//
// Mirrors the topic branch of /api/crypto/rooms/[roomId]/members so the live
// member-change publisher (apps/ws → REDIS_CHANNELS.TOPIC_MEMBERS_UPDATED) and
// the route share one source of truth.
//
//   member_user_ids  = topic_members rows for this topic
//   admin_user_ids   = role=admin, not anon, with at least one userKeyBundle
//                      uploaded (only when is_e2ee=true; plain topics return
//                      [] for parity with the route)
//
// Bots are excluded — bots cannot participate in Plan D E2EE rooms.
import { and, eq } from "drizzle-orm";
import {
  topicMembers,
  topics,
  userKeyBundles,
  users,
} from "@legends/db/schema";
import { db } from "@/lib/db";

export interface TopicCryptoMembers {
  memberUserIds: string[];
  adminUserIds: string[];
}

export async function listTopicCryptoMembers(topicId: string): Promise<TopicCryptoMembers | null> {
  const [topic] = await db
    .select({ id: topics.id, isE2ee: topics.isE2ee })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1);
  if (!topic) return null;

  const memberRows = await db
    .select({ userId: topicMembers.userId })
    .from(topicMembers)
    .where(eq(topicMembers.topicId, topic.id));
  const memberUserIds = memberRows.map((r) => r.userId).sort();

  let adminUserIds: string[] = [];
  if (topic.isE2ee) {
    const adminRows = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(userKeyBundles, eq(userKeyBundles.userId, users.id))
      .where(and(eq(users.role, "admin"), eq(users.isAnon, false)))
      .groupBy(users.id);
    adminUserIds = adminRows.map((r) => r.id).sort();
  }

  return { memberUserIds, adminUserIds };
}
