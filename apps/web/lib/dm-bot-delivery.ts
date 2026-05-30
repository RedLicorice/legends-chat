import { and, eq, inArray } from "drizzle-orm";
import { bots, dmParticipants } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

const UPDATE_QUEUE_TTL = 300; // mirror apps/ws/src/webhook.ts

// Same shape the SDK polls in apps/ws/src/webhook.ts WebhookUpdate, extended
// with a "dm_message" variant. Kept inline here so this helper has no cross-
// process import; the SDK declares the matching type in packages/bot-sdk.
type DmMessageEnvelope = {
  message_id: string;
  conversation_id: string;
  from: { id: string; display_name: string | null };
  text: string;
  reply_to_message_id?: string;
  date: number;
};
type DmUpdate = {
  update_id: string;
  type: "dm_message";
  dm_message: DmMessageEnvelope;
};

let counter = 0;
function nextId(): string { return String(++counter); }

async function botParticipantsFor(conversationId: string): Promise<{ botId: string; webhookUrl: string | null }[]> {
  const partRows = await db
    .select({ principalId: dmParticipants.principalId })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.conversationId, conversationId), eq(dmParticipants.principalType, "bot")));
  const ids = partRows.map((p) => p.principalId);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ botId: bots.id, webhookUrl: bots.webhookUrl })
    .from(bots)
    .where(and(inArray(bots.id, ids), eq(bots.isActive, true), eq(bots.dmEnabled, true)));
  return rows;
}

async function dispatch(botId: string, webhookUrl: string | null, update: DmUpdate): Promise<void> {
  const serialized = JSON.stringify(update);
  const queueKey = `legends:bot:updates:${botId}`;
  await Promise.all([
    redis.rpush(queueKey, serialized).then(() => redis.expire(queueKey, UPDATE_QUEUE_TTL)),
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

export async function deliverDmToBots(
  conversationId: string,
  msg: {
    id: string;
    senderType: "user" | "bot";
    senderId: string;
    senderDisplayName: string | null;
    text: string;
    replyToMessageId: string | null;
    createdAt: string;
  },
): Promise<void> {
  // Skip if the sender is itself a bot (don't loop a bot's own messages back to it).
  // (Plan C only has user-authored sends via /api/dm/[id]/messages, so this is defensive.)
  if (msg.senderType === "bot") return;

  const targets = await botParticipantsFor(conversationId);
  if (targets.length === 0) return;

  const update: DmUpdate = {
    update_id: nextId(),
    type: "dm_message",
    dm_message: {
      message_id: msg.id,
      conversation_id: conversationId,
      from: { id: msg.senderId, display_name: msg.senderDisplayName },
      text: msg.text,
      reply_to_message_id: msg.replyToMessageId ?? undefined,
      date: Math.floor(new Date(msg.createdAt).getTime() / 1000),
    },
  };

  await Promise.all(targets.map((t) => dispatch(t.botId, t.webhookUrl, update)));
}
