import webpush from "web-push";
import { and, eq, ne } from "drizzle-orm";
import { pushSubscriptions, topicMembers, topics, users } from "@legends/db/schema";
import { db } from "./db";

const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@example.com";

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export interface NotifyArgs {
  topicId: string;
  senderUserId: string | null;
  preview: string;
  messageId: string;
}

export async function notifyTopicMembers(args: NotifyArgs): Promise<void> {
  if (!ensureConfigured()) return;

  const [topicRow] = await db
    .select({ title: topics.title, isE2ee: topics.isE2ee })
    .from(topics)
    .where(eq(topics.id, args.topicId))
    .limit(1);
  if (!topicRow) return;
  const topicTitle = topicRow.title;

  let senderName = "Bot";
  if (args.senderUserId) {
    const [u] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, args.senderUserId))
      .limit(1);
    senderName = u?.displayName ?? "Someone";
  }
  const previewText = topicRow.isE2ee ? "New message" : args.preview.slice(0, 120);

  const recipients = await db
    .select({ userId: topicMembers.userId })
    .from(topicMembers)
    .where(
      args.senderUserId
        ? and(eq(topicMembers.topicId, args.topicId), ne(topicMembers.userId, args.senderUserId))
        : eq(topicMembers.topicId, args.topicId),
    );
  if (recipients.length === 0) return;

  const userIds = recipients.map((r) => r.userId);
  // Drizzle has no native inArray import here to avoid bundling cost; do per-user fetch.
  const subs = (
    await Promise.all(
      userIds.map((uid) =>
        db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, uid)),
      ),
    )
  ).flat();

  const payload = JSON.stringify({
    title: topicTitle,
    body: `${senderName}: ${previewText}`,
    topicId: args.topicId,
    messageId: args.messageId,
  });

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
        } else {
          console.error("[push] sendNotification failed", err);
        }
      }
    }),
  );
}
