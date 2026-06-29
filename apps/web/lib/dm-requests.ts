import { and, eq, sql } from "drizzle-orm";
import { notifications, users } from "@legends/db/schema";
import { REDIS_CHANNELS } from "@legends/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

/**
 * Shape of a `dm_request` notification row's `payload` jsonb. Frontend mirrors
 * this in `NotificationBell`. Keep in sync with the backfill in migration 0040.
 */
export type DmRequestPayload = {
  conversation_id: string;
  sender_user_id: string;
  sender_display_name: string;
  sender_avatar_url: string | null;
  is_e2ee: boolean;
};

/**
 * Insert a `dm_request` notification for the recipient of a pending DM and
 * fan it out over the existing notification socket relay
 * (REDIS_CHANNELS.NOTIFICATION_BROADCAST → WS_EVENTS.NOTIFICATION_NEW).
 *
 * Idempotent: re-opening the same pending conversation will not duplicate the
 * unread notification, since we look up an existing unread row first.
 *
 * Bot DMs do not pass through here — `openConversation` auto-accepts bot
 * threads, so there's no pending state and no request to notify on.
 */
export async function emitDmRequestNotification(args: {
  conversationId: string;
  recipientUserId: string;
  senderUserId: string;
  isE2ee: boolean;
}): Promise<void> {
  // Dedup: if there's already an unread dm_request for this conversation
  // pointed at this user, skip. We use payload->>'conversation_id' to match
  // since the FK isn't a real column on notifications.
  const existing = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, args.recipientUserId),
        eq(notifications.type, "dm_request"),
        sql`(${notifications.payload}->>'conversation_id') = ${args.conversationId}`,
        sql`${notifications.readAt} IS NULL`,
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  const [sender] = await db
    .select({ displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, args.senderUserId))
    .limit(1);

  const payload: DmRequestPayload = {
    conversation_id: args.conversationId,
    sender_user_id: args.senderUserId,
    sender_display_name: sender?.displayName ?? "Unknown",
    sender_avatar_url: sender?.avatarUrl ?? null,
    is_e2ee: args.isE2ee,
  };

  const [row] = await db
    .insert(notifications)
    .values({
      userId: args.recipientUserId,
      type: "dm_request",
      payload,
    })
    .returning();
  if (!row) return;

  await redis.publish(
    REDIS_CHANNELS.NOTIFICATION_BROADCAST,
    JSON.stringify({
      notifs: [
        {
          id: row.id,
          userId: row.userId,
          type: row.type,
          payload: row.payload,
          createdAt: row.createdAt.toISOString(),
        },
      ],
    }),
  );
}

/**
 * Publish a `dm:conversation:updated` event over the WS relay so every
 * participant's sidebar can refresh its server snapshot. The web app POSTs
 * accept/decline; this lets the other side react without polling.
 *
 * `state` is normally one of the DB enum values, but decline now *deletes* the
 * conversation row instead of soft-blocking it (see route notes), so we also
 * publish a synthetic `"declined"` so the WS handler can drop the row from
 * sidebars without re-fetching state that no longer exists.
 *
 * Fan-out lives in apps/ws — see REDIS_CHANNELS.DM_CONVERSATION_UPDATED.
 */
export async function publishDmConversationUpdated(args: {
  conversationId: string;
  state: "pending" | "accepted" | "blocked" | "declined" | "deleted";
  userIds: string[];
}): Promise<void> {
  if (args.userIds.length === 0) return;
  await redis.publish(
    REDIS_CHANNELS.DM_CONVERSATION_UPDATED,
    JSON.stringify({
      conversationId: args.conversationId,
      state: args.state,
      userIds: args.userIds,
    }),
  );
}

/**
 * Shape of the payload jsonb for a `dm_request_declined` notification. Sent
 * to the *initiator* when the recipient declines their conversation request.
 * The conversation row no longer exists by the time this notification reaches
 * the client, so we inline the recipient's display name (lookup would 404).
 */
export type DmRequestDeclinedPayload = {
  conversation_id: string;
  recipient_user_id: string;
  recipient_display_name: string;
};

/**
 * Insert a `dm_request_declined` notification for the initiator and fan it
 * out the same way `emitDmRequestNotification` does. Conversation row is
 * already gone by the time we call this — pass the recipient display name in
 * so we don't try a doomed join.
 */
export async function emitDmRequestDeclinedNotification(args: {
  conversationId: string;
  initiatorUserId: string;
  recipientUserId: string;
  recipientDisplayName: string;
}): Promise<void> {
  const payload: DmRequestDeclinedPayload = {
    conversation_id: args.conversationId,
    recipient_user_id: args.recipientUserId,
    recipient_display_name: args.recipientDisplayName,
  };

  const [row] = await db
    .insert(notifications)
    .values({
      userId: args.initiatorUserId,
      type: "dm_request_declined",
      payload,
    })
    .returning();
  if (!row) return;

  await redis.publish(
    REDIS_CHANNELS.NOTIFICATION_BROADCAST,
    JSON.stringify({
      notifs: [
        {
          id: row.id,
          userId: row.userId,
          type: row.type,
          payload: row.payload,
          createdAt: row.createdAt.toISOString(),
        },
      ],
    }),
  );
}

/**
 * Mark any `dm_request` notification(s) for `conversationId` as read for the
 * given recipient. Called from accept/decline endpoints so the bell badge
 * decrements as soon as the user acts on the request.
 */
export async function markDmRequestNotificationsRead(args: {
  recipientUserId: string;
  conversationId: string;
}): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, args.recipientUserId),
        eq(notifications.type, "dm_request"),
        sql`(${notifications.payload}->>'conversation_id') = ${args.conversationId}`,
        sql`${notifications.readAt} IS NULL`,
      ),
    );
}
