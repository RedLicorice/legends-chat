import { eq, inArray, or, sql } from "drizzle-orm";
import { type Server } from "socket.io";
import { messages, notifications, roles, topicMembers, users } from "@legends/db/schema";
import { WS_EVENTS } from "@legends/shared";
import { db } from "./db";

export async function dispatchMessageNotifications(
  io: Server,
  args: {
    messageId: string;
    topicId: string;
    topicSlug: string;
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

  const basePayload = {
    messageId: args.messageId,
    topicId: args.topicId,
    topicSlug: args.topicSlug,
    topicTitle: args.topicTitle,
    senderUserId: args.senderUserId,
    senderName: args.senderName,
    preview: args.text.slice(0, 100),
  };

  // Reply notification
  if (args.replyToMessageId) {
    const [original] = await db
      .select({ senderUserId: messages.senderUserId })
      .from(messages)
      .where(eq(messages.id, BigInt(args.replyToMessageId)))
      .limit(1);
    if (original?.senderUserId && !notifiedUsers.has(original.senderUserId)) {
      notifiedUsers.add(original.senderUserId);
      inserts.push({ userId: original.senderUserId, type: "reply", payload: basePayload });
    }
  }

  // Parse @mentions
  const mentionPattern = /@([\w.]+)/g;
  const handles: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = mentionPattern.exec(args.text)) !== null) {
    handles.push(m[1]!.toLowerCase());
  }

  if (handles.length > 0) {
    // @everyone: notify all topic members
    if (handles.includes("everyone")) {
      const memberRows = await db
        .select({ userId: topicMembers.userId })
        .from(topicMembers)
        .where(eq(topicMembers.topicId, args.topicId));
      for (const r of memberRows) {
        if (notifiedUsers.has(r.userId)) continue;
        notifiedUsers.add(r.userId);
        inserts.push({ userId: r.userId, type: "mention", payload: basePayload });
      }
    }

    const nonEveryoneHandles = handles.filter((h) => h !== "everyone");

    if (nonEveryoneHandles.length > 0) {
      // @role: check if handle matches a role name, notify all users with that role
      const matchedRoles = await db
        .select({ name: roles.name })
        .from(roles)
        .where(inArray(roles.name, nonEveryoneHandles));

      const roleNames = matchedRoles.map((r) => r.name);
      if (roleNames.length > 0) {
        const roleUsers = await db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.role, roleNames))
          .limit(200);
        for (const u of roleUsers) {
          if (notifiedUsers.has(u.id)) continue;
          notifiedUsers.add(u.id);
          inserts.push({ userId: u.id, type: "mention", payload: basePayload });
        }
      }

      // @user: match by telegramUsername or lowercased displayName
      const nonRoleHandles = nonEveryoneHandles.filter((h) => !roleNames.includes(h));
      if (nonRoleHandles.length > 0) {
        const mentionedUsers = await db
          .select({ id: users.id })
          .from(users)
          .where(
            or(
              inArray(users.telegramUsername, nonRoleHandles),
              inArray(sql`lower(${users.displayName})`, nonRoleHandles),
            )!,
          )
          .limit(20);
        for (const u of mentionedUsers) {
          if (notifiedUsers.has(u.id)) continue;
          notifiedUsers.add(u.id);
          inserts.push({ userId: u.id, type: "mention", payload: basePayload });
        }
      }
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
