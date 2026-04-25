import { and, eq } from "drizzle-orm";
import { bots, topics, topicBots } from "@legends/db/schema";
import { db } from "./db";
import { cacheClient } from "./redis";

export interface WebhookUpdate {
  update_id: string;
  type: "message" | "callback_query" | "new_member";
  message?: unknown;
  callback_query?: unknown;
  new_member?: {
    user_id: string;
    display_name: string;
    username: string | null;
    topic_id: string;
    topic_title: string;
  };
}

let updateCounter = 0;
function nextUpdateId(): string {
  return String(++updateCounter);
}

const UPDATE_QUEUE_TTL = 300; // 5 minutes

async function getTopicBots(topicId: string): Promise<{ botId: string; webhookUrl: string | null }[]> {
  const rows = await db
    .select({ botId: topicBots.botId, webhookUrl: bots.webhookUrl })
    .from(topicBots)
    .innerJoin(bots, eq(topicBots.botId, bots.id))
    .where(and(eq(topicBots.topicId, topicId), eq(bots.isActive, true)));
  return rows;
}

async function dispatchUpdate(botId: string, webhookUrl: string | null, update: WebhookUpdate): Promise<void> {
  const serialized = JSON.stringify(update);
  const queueKey = `legends:bot:updates:${botId}`;

  await Promise.all([
    cacheClient.rpush(queueKey, serialized).then(() => cacheClient.expire(queueKey, UPDATE_QUEUE_TTL)),
    webhookUrl
      ? fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: serialized,
          signal: AbortSignal.timeout(5000),
        }).catch(() => {})
      : Promise.resolve(),
  ]);
}

export async function deliverMessageToWebhooks(
  topicId: string,
  topicTitle: string,
  message: {
    id: string;
    text: string;
    senderUserId: string | null;
    senderDisplayName: string | null;
    botId: string | null;
    replyToMessageId: string | null;
    createdAt: Date;
  },
): Promise<void> {
  const botList = await getTopicBots(topicId);
  // Don't dispatch back to the bot that sent this message
  const targets = botList.filter((b) => b.botId !== message.botId);
  if (targets.length === 0) return;

  const update: WebhookUpdate = {
    update_id: nextUpdateId(),
    type: "message",
    message: {
      message_id: message.id,
      from: { id: message.senderUserId ?? message.botId, display_name: message.senderDisplayName },
      chat: { id: topicId, type: "group", title: topicTitle },
      text: message.text,
      reply_to_message_id: message.replyToMessageId ?? undefined,
      date: Math.floor(message.createdAt.getTime() / 1000),
    },
  };

  await Promise.all(targets.map((b) => dispatchUpdate(b.botId, b.webhookUrl, update)));
}

export async function deliverCallbackQueryToWebhooks(
  topicId: string,
  botId: string,
  callbackQueryId: string,
  messageId: string,
  senderId: string,
  senderDisplayName: string | null,
  callbackData: string,
): Promise<void> {
  const [row] = await db
    .select({ webhookUrl: bots.webhookUrl })
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.isActive, true)))
    .limit(1);

  const update: WebhookUpdate = {
    update_id: nextUpdateId(),
    type: "callback_query",
    callback_query: {
      id: callbackQueryId,
      from: { id: senderId, display_name: senderDisplayName },
      message: { message_id: messageId, chat: { id: topicId } },
      data: callbackData,
    },
  };

  await dispatchUpdate(botId, row?.webhookUrl ?? null, update);
}

export async function deliverNewMemberToWebhooks(
  userId: string,
  displayName: string,
  username: string | null,
  topicId: string,
): Promise<void> {
  const [topic] = await db
    .select({ title: topics.title })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1);

  if (!topic) return;

  const botList = await getTopicBots(topicId);
  if (botList.length === 0) return;

  const update: WebhookUpdate = {
    update_id: nextUpdateId(),
    type: "new_member",
    new_member: {
      user_id: userId,
      display_name: displayName,
      username,
      topic_id: topicId,
      topic_title: topic.title,
    },
  };

  await Promise.all(botList.map((b) => dispatchUpdate(b.botId, b.webhookUrl, update)));
}
