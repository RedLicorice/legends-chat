import { eq, inArray } from "drizzle-orm";
import { type Server } from "socket.io";
import { messages, notifications, users } from "@legends/db/schema";
import { WS_EVENTS } from "@legends/shared";
import { db } from "./db";

export async function dispatchMessageNotifications(
  io: Server,
  args: {
    messageId: string;
    topicId: string;
    topicTitle: string;
    senderUserId: string;
    senderName: string;
    text: string;
    replyToMessageId: string | null;
  },
): Promise<void> {
  const notifiedUsers = new Set<string>();
  notifiedUsers.add(args.senderUserId); // never notify sender

  const inserts: { userId: string; type: string; payload: Record<string, unknown> }[] = [];

  // Reply notification
  if (args.replyToMessageId) {
    const [original] = await db
      .select({ senderUserId: messages.senderUserId })
      .from(messages)
      .where(eq(messages.id, BigInt(args.replyToMessageId)))
      .limit(1);
    if (original?.senderUserId && !notifiedUsers.has(original.senderUserId)) {
      notifiedUsers.add(original.senderUserId);
      inserts.push({
        userId: original.senderUserId,
        type: "reply",
        payload: {
          messageId: args.messageId,
          topicId: args.topicId,
          topicTitle: args.topicTitle,
          senderUserId: args.senderUserId,
          senderName: args.senderName,
          preview: args.text.slice(0, 100),
        },
      });
    }
  }

  // Mention notifications: match @displayName or @telegramUsername
  const mentionPattern = /@([\w.]+)/g;
  const handles: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = mentionPattern.exec(args.text)) !== null) {
    handles.push(m[1]!.toLowerCase());
  }

  if (handles.length > 0) {
    const mentionedUsers = await db
      .select({ id: users.id, telegramUsername: users.telegramUsername, displayName: users.displayName })
      .from(users)
      .where(
        inArray(users.telegramUsername, handles),
      )
      .limit(20);

    for (const u of mentionedUsers) {
      if (notifiedUsers.has(u.id)) continue;
      notifiedUsers.add(u.id);
      inserts.push({
        userId: u.id,
        type: "mention",
        payload: {
          messageId: args.messageId,
          topicId: args.topicId,
          topicTitle: args.topicTitle,
          senderUserId: args.senderUserId,
          senderName: args.senderName,
          preview: args.text.slice(0, 100),
        },
      });
    }
  }

  if (inserts.length === 0) return;

  for (const notif of inserts) {
    const [inserted] = await db
      .insert(notifications)
      .values(notif)
      .returning();
    if (inserted) {
      io.to(`user:${notif.userId}`).emit(WS_EVENTS.NOTIFICATION_NEW, {
        id: inserted.id,
        type: inserted.type,
        payload: inserted.payload,
        readAt: null,
        createdAt: inserted.createdAt,
      });
    }
  }
}
