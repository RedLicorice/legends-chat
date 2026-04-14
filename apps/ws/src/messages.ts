import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  encryptionKeys,
  messageReactions,
  messages,
  topicMembers,
  topics,
  userMutes,
} from "@legends/db/schema";
import {
  decryptMessage,
  encryptMessage,
  generateDataKey,
  unwrapKey,
  wrapKey,
} from "@legends/crypto";
import { db } from "./db.js";

let cachedKey: { id: string; data: Uint8Array } | null = null;

async function currentDataKey(): Promise<{ id: string; data: Uint8Array }> {
  if (cachedKey) return cachedKey;
  const rows = await db
    .select()
    .from(encryptionKeys)
    .where(eq(encryptionKeys.purpose, "messages"))
    .orderBy(desc(encryptionKeys.createdAt))
    .limit(1);
  if (rows[0]) {
    cachedKey = { id: rows[0].id, data: unwrapKey(rows[0].wrappedKey) };
    return cachedKey;
  }
  const data = generateDataKey();
  const { wrapped } = wrapKey(data);
  const [inserted] = await db
    .insert(encryptionKeys)
    .values({ purpose: "messages", wrappedKey: wrapped })
    .returning();
  cachedKey = { id: inserted!.id, data };
  return cachedKey;
}

const keyDataCache = new Map<string, Uint8Array>();
async function getKeyData(keyId: string): Promise<Uint8Array> {
  const cached = keyDataCache.get(keyId);
  if (cached) return cached;
  const rows = await db.select().from(encryptionKeys).where(eq(encryptionKeys.id, keyId)).limit(1);
  if (!rows[0]) throw new Error(`encryption key ${keyId} not found`);
  const data = unwrapKey(rows[0].wrappedKey);
  keyDataCache.set(keyId, data);
  return data;
}

export interface InsertedMessage {
  id: string;
  topicId: string;
  senderUserId: string | null;
  botId: string | null;
  replyToMessageId: string | null;
  text: string;
  createdAt: Date;
  editedAt: Date | null;
}

export async function insertMessage(args: {
  topicId: string;
  senderUserId: string | null;
  botId?: string | null;
  text: string;
  replyToMessageId?: string | null;
}): Promise<InsertedMessage> {
  const key = await currentDataKey();
  const aad = new TextEncoder().encode(args.topicId);
  const { ciphertext, nonce } = encryptMessage(key.data, args.text, aad);
  const [row] = await db
    .insert(messages)
    .values({
      topicId: args.topicId,
      senderUserId: args.senderUserId,
      botId: args.botId ?? null,
      replyToMessageId: args.replyToMessageId ? BigInt(args.replyToMessageId) : null,
      contentCiphertext: ciphertext,
      contentNonce: nonce,
      keyId: key.id,
    })
    .returning();
  return {
    id: row!.id.toString(),
    topicId: row!.topicId,
    senderUserId: row!.senderUserId,
    botId: row!.botId,
    replyToMessageId: row!.replyToMessageId?.toString() ?? null,
    text: args.text,
    createdAt: row!.createdAt,
    editedAt: row!.editedAt,
  };
}

export interface ReactionRow {
  messageId: string;
  userId: string;
  emojiKey: string;
}

export async function listReactionsForTopic(topicId: string, limit = 200): Promise<ReactionRow[]> {
  const recent = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.topicId, topicId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.id))
    .limit(limit);
  if (recent.length === 0) return [];
  const ids = recent.map((r) => r.id);
  const rows = await db
    .select()
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, ids));
  return rows.map((r) => ({ messageId: r.messageId.toString(), userId: r.userId, emojiKey: r.emojiKey }));
}

export async function listRecentMessages(topicId: string, limit = 50): Promise<InsertedMessage[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.topicId, topicId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.id))
    .limit(limit);
  rows.reverse();
  const aad = new TextEncoder().encode(topicId);
  const out: InsertedMessage[] = [];
  for (const r of rows) {
    const key = await getKeyData(r.keyId);
    const text = decryptMessage(key, r.contentCiphertext, r.contentNonce, aad);
    out.push({
      id: r.id.toString(),
      topicId: r.topicId,
      senderUserId: r.senderUserId,
      botId: r.botId,
      replyToMessageId: r.replyToMessageId?.toString() ?? null,
      text,
      createdAt: r.createdAt,
      editedAt: r.editedAt,
    });
  }
  return out;
}

export async function isUserMuted(userId: string): Promise<{ reason: string; expiresAt: Date | null } | null> {
  const now = new Date();
  const rows = await db
    .select()
    .from(userMutes)
    .where(
      and(
        eq(userMutes.userId, userId),
        isNull(userMutes.liftedAt),
        or(isNull(userMutes.expiresAt), gt(userMutes.expiresAt, now)),
      ),
    )
    .orderBy(desc(userMutes.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { reason: row.reason, expiresAt: row.expiresAt };
}

export async function ensureTopicMembership(userId: string, topicId: string): Promise<void> {
  await db
    .insert(topicMembers)
    .values({ topicId, userId })
    .onConflictDoNothing();
}

export async function setLastReadMessage(userId: string, topicId: string, messageId: string): Promise<void> {
  await db
    .update(topicMembers)
    .set({ lastReadMessageId: BigInt(messageId) })
    .where(and(eq(topicMembers.userId, userId), eq(topicMembers.topicId, topicId)));
}

export async function listTopics() {
  return db.select().from(topics).orderBy(desc(topics.isSticky), asc(topics.sortOrder));
}

export async function getTopicAutoDelete(
  topicId: string,
): Promise<{ mode: "none" | "age" | "count"; max: number | null } | null> {
  const [row] = await db
    .select({
      mode: topics.autoDeleteMode,
      max: topics.autoDeleteMaxMessages,
    })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1);
  if (!row) return null;
  return { mode: row.mode, max: row.max };
}

export type ReactionToggleResult =
  | { added: true; messageId: string; userId: string; emojiKey: string }
  | { added: false; messageId: string; userId: string; emojiKey: string };

export async function toggleReaction(args: {
  messageId: string;
  userId: string;
  emojiKey: string;
}): Promise<ReactionToggleResult> {
  const messageId = BigInt(args.messageId);
  const existing = await db
    .select()
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, args.userId),
        eq(messageReactions.emojiKey, args.emojiKey),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, args.userId),
          eq(messageReactions.emojiKey, args.emojiKey),
        ),
      );
    return { added: false, messageId: args.messageId, userId: args.userId, emojiKey: args.emojiKey };
  }

  await db.insert(messageReactions).values({
    messageId,
    userId: args.userId,
    emojiKey: args.emojiKey,
  });
  return { added: true, messageId: args.messageId, userId: args.userId, emojiKey: args.emojiKey };
}

export async function getMessageTopicId(messageId: string): Promise<string | null> {
  const rows = await db
    .select({ topicId: messages.topicId })
    .from(messages)
    .where(eq(messages.id, BigInt(messageId)))
    .limit(1);
  return rows[0]?.topicId ?? null;
}

