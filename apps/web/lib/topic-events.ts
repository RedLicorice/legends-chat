// Topic-level Redis publishers consumed by the WS relay.
//
// Mirror of apps/web/lib/dm-requests.ts:publishDmConversationUpdated. The WS
// process subscribes to REDIS_CHANNELS.TOPIC_MEMBERS_UPDATED in apps/ws/src/
// index.ts and fans the event into the `topic:<topicId>` room so every viewer
// (TopicView) can rotate its Megolm session immediately rather than waiting
// for the next send.
//
// Payload shape — keep in sync with the WS subscriber + TopicView listener:
//   {
//     topicId,
//     action: "join" | "leave",
//     affectedUserId,
//     memberUserIds,   // topic_members rows (sorted)
//     adminUserIds,    // admins-with-bundles for is_e2ee topics (sorted)
//   }
import { REDIS_CHANNELS } from "@legends/shared";
import { redis } from "@/lib/redis";
import { listTopicCryptoMembers } from "@/lib/topic-members";

export type TopicMembersAction = "join" | "leave";

export interface TopicMembersUpdatedPayload {
  topicId: string;
  action: TopicMembersAction;
  affectedUserId: string;
  memberUserIds: string[];
  adminUserIds: string[];
}

/**
 * Publish a topic membership change so every connected TopicView can
 * proactively rotate its Megolm session. Caller passes the precomputed
 * `memberUserIds`/`adminUserIds` when it already has them; otherwise pass
 * `null` to have the helper query via `listTopicCryptoMembers`.
 *
 * No-op when the topic doesn't exist (defensive: a delete race shouldn't
 * crash the join path).
 */
export async function publishTopicMembersUpdated(args: {
  topicId: string;
  action: TopicMembersAction;
  affectedUserId: string;
  memberUserIds?: string[] | null;
  adminUserIds?: string[] | null;
}): Promise<void> {
  let memberUserIds = args.memberUserIds ?? null;
  let adminUserIds = args.adminUserIds ?? null;
  if (memberUserIds === null || adminUserIds === null) {
    const computed = await listTopicCryptoMembers(args.topicId);
    if (!computed) return;
    memberUserIds = memberUserIds ?? computed.memberUserIds;
    adminUserIds = adminUserIds ?? computed.adminUserIds;
  }
  const payload: TopicMembersUpdatedPayload = {
    topicId: args.topicId,
    action: args.action,
    affectedUserId: args.affectedUserId,
    memberUserIds,
    adminUserIds,
  };
  await redis.publish(REDIS_CHANNELS.TOPIC_MEMBERS_UPDATED, JSON.stringify(payload));
}
