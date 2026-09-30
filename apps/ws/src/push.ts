import webpush from "web-push";
import { and, eq, inArray, ne } from "drizzle-orm";
import { pushSubscriptions, topicMembers, topics, users } from "@legends/db/schema";
import { createLogger } from "@legends/shared";
import { db } from "./db";
import { filterUsersWhoCanViewTopic } from "./messages";
import { SsrfError, assertPublicHttpsUrl } from "./ssrf";

const log = createLogger("ws:push");

// Log the host only — a push endpoint embeds a per-device bearer-ish token.
function hostOf(raw: string): string {
  try { return new URL(raw).host; } catch { return "invalid"; }
}

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
    .select({ title: topics.title, isE2ee: topics.isE2ee, slug: topics.slug })
    .from(topics)
    .where(eq(topics.id, args.topicId))
    .limit(1);
  if (!topicRow) return;
  const topicTitle = topicRow.title;
  const topicSlug = topicRow.slug;

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

  // #rt-5: topic_members rows are written on first join and never removed when
  // the member is demoted or the topic is later restricted. Pushing to the raw
  // list puts a preview of a topic they can no longer open on their lock screen.
  const userIds = await filterUsersWhoCanViewTopic(
    args.topicId,
    recipients.map((r) => r.userId),
  );
  if (userIds.length === 0) return;

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, userIds));

  const payload = JSON.stringify({
    title: topicTitle,
    body: `${senderName}: ${previewText}`,
    topicSlug,
    messageId: args.messageId,
  });

  await Promise.all(
    subs.map(async (s) => {
      try {
        // #rt-4: the endpoint is attacker-supplied at subscribe time. Validating
        // it there is not enough — DNS can be re-pointed at an internal address
        // afterwards, and rows predating that validation still exist. Re-check
        // immediately before this process makes the outbound request.
        await assertPublicHttpsUrl(s.endpoint);
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
      } catch (err: unknown) {
        if (err instanceof SsrfError) {
          log.error("push endpoint rejected by SSRF guard", { endpointHost: hostOf(s.endpoint), reason: err.message });
          return;
        }
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
        } else {
          log.error("sendNotification failed", err);
        }
      }
    }),
  );
}
