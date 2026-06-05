import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  encryptionKeys,
  messageEdits,
  messageReactions,
  messages,
  pollOptions,
  polls,
  pollVotes,
  topicMembers,
  topics,
  userDeviceChangeLog,
  userKeyBundles,
  userMutes,
  users,
} from "@legends/db/schema";
import {
  decryptMessage,
  encryptMessage,
  generateDataKey,
  unwrapKey,
  wrapKey,
} from "@legends/crypto";
import { REDIS_CHANNELS } from "@legends/shared";
import { db } from "./db";
import { pubClient } from "./redis";

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

export interface PollOption {
  id: string;
  text: string;
  position: number;
  voteCount: number;
}

export interface PollData {
  id: string;
  question: string;
  options: PollOption[];
  isAnonymous: boolean;
  allowsMultiple: boolean;
  isClosed: boolean;
  totalVotes: number;
  topicId?: string;
}

export interface MessageAttachment {
  type: "image" | "gif";
  url: string;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
}

export interface InlineKeyboardButton { text: string; callbackData: string }

export interface InsertedMessage {
  id: string;
  topicId: string;
  senderUserId: string | null;
  senderDisplayName: string | null;
  senderAvatarUrl: string | null;
  senderIsAnon: boolean;
  senderRole: string | null;
  botId: string | null;
  replyToMessageId: string | null;
  text: string;
  attachments: MessageAttachment[];
  inlineKeyboard?: InlineKeyboardButton[][] | null;
  createdAt: Date;
  editedAt: Date | null;
  poll?: PollData;
  /** Megolm envelope for E2EE topic rows; null otherwise. */
  ciphertextJson?: Record<string, unknown> | null;
}

function encodeContent(text: string, attachments?: MessageAttachment[]): string {
  if (!attachments || attachments.length === 0) return text;
  return JSON.stringify({ v: 1, t: text, a: attachments });
}

function decodeContent(raw: string): { text: string; attachments: MessageAttachment[] } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "v" in parsed &&
      (parsed as { v: unknown }).v === 1
    ) {
      const p = parsed as { t?: unknown; a?: unknown };
      return {
        text: typeof p.t === "string" ? p.t : "",
        attachments: Array.isArray(p.a) ? (p.a as MessageAttachment[]) : [],
      };
    }
  } catch {
    // plain text
  }
  return { text: raw, attachments: [] };
}

export async function insertMessage(args: {
  topicId: string;
  senderUserId: string | null;
  botId?: string | null;
  /** Plaintext body (mutually exclusive with `ciphertextJson`). */
  text: string;
  attachments?: MessageAttachment[];
  replyToMessageId?: string | null;
  searchText?: string;
  hashtags?: string[];
  /**
   * Megolm envelope for E2EE topics. When provided, `text`/`attachments` are
   * ignored on the storage side: content_ciphertext is written as empty bytes
   * and ciphertext_json carries the payload. The CHECK constraint
   * `messages_payload_chk` enforces the XOR at the DB level.
   */
  ciphertextJson?: Record<string, unknown> | null;
}): Promise<InsertedMessage> {
  const key = await currentDataKey();
  const isE2ee = !!args.ciphertextJson;

  let contentCiphertext: Uint8Array;
  let contentNonce: Uint8Array;
  if (isE2ee) {
    // E2EE row: leave content_ciphertext empty; ciphertext_json carries the
    // Megolm envelope. CHECK constraint requires
    //   (octet_length(content_ciphertext) > 0) XOR (ciphertext_json IS NOT NULL).
    contentCiphertext = new Uint8Array(0);
    contentNonce = new Uint8Array(0);
  } else {
    const aad = new TextEncoder().encode(args.topicId);
    const encoded = encodeContent(args.text, args.attachments);
    const enc = encryptMessage(key.data, encoded, aad);
    contentCiphertext = enc.ciphertext;
    contentNonce = enc.nonce;
  }

  const [row] = await db
    .insert(messages)
    .values({
      topicId: args.topicId,
      senderUserId: args.senderUserId,
      botId: args.botId ?? null,
      replyToMessageId: args.replyToMessageId ? BigInt(args.replyToMessageId) : null,
      contentCiphertext,
      contentNonce,
      keyId: key.id,
      ciphertextJson: args.ciphertextJson ?? null,
      hashtags: args.hashtags && args.hashtags.length > 0 ? args.hashtags : [],
    })
    .returning();

  // Search vector skipped for E2EE rows — there is no plaintext to index.
  if (!isE2ee && args.searchText !== undefined && args.searchText.trim().length > 0) {
    await db.execute(
      sql`UPDATE messages SET search_vector = to_tsvector('english', ${args.searchText}) WHERE id = ${row!.id}`,
    );
  }

  let senderDisplayName: string | null = null;
  let senderAvatarUrl: string | null = null;
  let senderIsAnon = false;
  let senderRole: string | null = null;
  if (args.senderUserId) {
    const [u] = await db
      .select({ displayName: users.displayName, isAnon: users.isAnon, avatarUrl: users.avatarUrl, role: users.role })
      .from(users)
      .where(eq(users.id, args.senderUserId))
      .limit(1);
    if (u) { senderDisplayName = u.displayName; senderIsAnon = u.isAnon; senderAvatarUrl = u.avatarUrl; senderRole = u.role; }
  }

  return {
    id: row!.id.toString(),
    topicId: row!.topicId,
    senderUserId: row!.senderUserId,
    senderDisplayName,
    senderAvatarUrl,
    senderIsAnon,
    senderRole,
    botId: row!.botId,
    replyToMessageId: row!.replyToMessageId?.toString() ?? null,
    // For E2EE rows the server has no plaintext to surface — pass through the
    // envelope so the originating socket round-trip carries the same shape
    // recipients will see via MESSAGE_NEW.
    text: isE2ee ? "" : args.text,
    attachments: isE2ee ? [] : (args.attachments ?? []),
    inlineKeyboard: null,
    createdAt: row!.createdAt,
    editedAt: row!.editedAt,
    ciphertextJson: args.ciphertextJson ?? null,
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

export async function listRecentMessages(topicId: string, limit = 50, viewerId?: string): Promise<InsertedMessage[]> {
  const rows = await db
    .select({
      id: messages.id,
      topicId: messages.topicId,
      senderUserId: messages.senderUserId,
      botId: messages.botId,
      replyToMessageId: messages.replyToMessageId,
      contentCiphertext: messages.contentCiphertext,
      contentNonce: messages.contentNonce,
      ciphertextJson: messages.ciphertextJson,
      keyId: messages.keyId,
      inlineKeyboard: messages.inlineKeyboard,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      senderDisplayName: users.displayName,
      senderAvatarUrl: users.avatarUrl,
      senderIsAnon: users.isAnon,
      senderRole: users.role,
    })
    .from(messages)
    .leftJoin(users, eq(messages.senderUserId, users.id))
    .where(and(eq(messages.topicId, topicId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.id))
    .limit(limit);
  rows.reverse();
  const aad = new TextEncoder().encode(topicId);
  const out: InsertedMessage[] = [];
  for (const r of rows) {
    let text = "";
    let attachments: MessageAttachment[] = [];
    const isE2eeRow = !!r.ciphertextJson;
    if (!isE2eeRow) {
      const key = await getKeyData(r.keyId);
      const raw = decryptMessage(key, r.contentCiphertext, r.contentNonce, aad);
      const decoded = decodeContent(raw);
      text = decoded.text;
      attachments = decoded.attachments;
    }
    out.push({
      id: r.id.toString(),
      topicId: r.topicId,
      senderUserId: r.senderUserId,
      senderDisplayName: r.senderDisplayName ?? null,
      senderAvatarUrl: r.senderAvatarUrl ?? null,
      senderIsAnon: r.senderIsAnon ?? false,
      senderRole: r.senderRole ?? null,
      botId: r.botId,
      replyToMessageId: r.replyToMessageId?.toString() ?? null,
      text,
      attachments,
      inlineKeyboard: r.inlineKeyboard as InlineKeyboardButton[][] | null | undefined,
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      ciphertextJson: r.ciphertextJson ?? null,
    });
  }

  // Attach poll data for any poll messages
  if (out.length > 0) {
    const msgBigInts = out.map((m) => BigInt(m.id));
    const pollRows = await db.select().from(polls).where(inArray(polls.messageId, msgBigInts));
    if (pollRows.length > 0) {
      const pollIds = pollRows.map((p) => p.id);
      const [optRows, voteRows, myVoteRows] = await Promise.all([
        db.select().from(pollOptions).where(inArray(pollOptions.pollId, pollIds)).orderBy(asc(pollOptions.position)),
        db.select({ pollId: pollVotes.pollId, optionId: pollVotes.optionId }).from(pollVotes).where(inArray(pollVotes.pollId, pollIds)),
        viewerId
          ? db.select({ pollId: pollVotes.pollId, optionId: pollVotes.optionId }).from(pollVotes).where(and(inArray(pollVotes.pollId, pollIds), eq(pollVotes.userId, viewerId)))
          : Promise.resolve([] as { pollId: string; optionId: string }[]),
      ]);
      const pollByMsgId = new Map<string, PollData>();
      for (const poll of pollRows) {
        const opts = optRows.filter((o) => o.pollId === poll.id);
        const vcMap = new Map<string, number>();
        for (const v of voteRows) {
          if (v.pollId === poll.id) vcMap.set(v.optionId, (vcMap.get(v.optionId) ?? 0) + 1);
        }
        const totalVotes = Array.from(vcMap.values()).reduce((a, b) => a + b, 0);
        pollByMsgId.set(poll.messageId.toString(), {
          id: poll.id,
          question: poll.question,
          options: opts.map((o) => ({ id: o.id, text: o.text, position: o.position, voteCount: vcMap.get(o.id) ?? 0 })),
          isAnonymous: poll.isAnonymous,
          allowsMultiple: poll.allowsMultiple,
          isClosed: poll.isClosed,
          totalVotes,
        });
      }
      for (const msg of out) {
        const pd = pollByMsgId.get(msg.id);
        if (pd) msg.poll = pd;
      }
    }
  }

  return out;
}

export async function createPollMessage(args: {
  topicId: string;
  createdByUserId: string;
  question: string;
  options: string[];
  isAnonymous: boolean;
  allowsMultiple: boolean;
}): Promise<InsertedMessage> {
  const msg = await insertMessage({
    topicId: args.topicId,
    senderUserId: args.createdByUserId,
    text: `📊 ${args.question}`,
  });
  const [poll] = await db
    .insert(polls)
    .values({
      messageId: BigInt(msg.id),
      question: args.question,
      isAnonymous: args.isAnonymous,
      allowsMultiple: args.allowsMultiple,
      createdByUserId: args.createdByUserId,
    })
    .returning();
  const optionRows = args.options.map((text, i) => ({ pollId: poll!.id, text, position: i }));
  const insertedOptions = await db.insert(pollOptions).values(optionRows).returning();
  return {
    ...msg,
    poll: {
      id: poll!.id,
      question: args.question,
      options: insertedOptions.map((o) => ({ id: o.id, text: o.text, position: o.position, voteCount: 0 })),
      isAnonymous: args.isAnonymous,
      allowsMultiple: args.allowsMultiple,
      isClosed: false,
      totalVotes: 0,
    },
  };
}

export async function castPollVote(args: {
  pollId: string;
  userId: string;
  optionIds: string[];
}): Promise<{ ok: boolean; error?: string; myVotes: string[]; pollData: PollData | null }> {
  const [poll] = await db.select().from(polls).where(eq(polls.id, args.pollId)).limit(1);
  if (!poll) return { ok: false, error: "Poll not found", myVotes: [], pollData: null };
  if (poll.isClosed) return { ok: false, error: "Poll is closed", myVotes: [], pollData: null };
  if (!poll.allowsMultiple && args.optionIds.length > 1) {
    return { ok: false, error: "Only one option allowed", myVotes: [], pollData: null };
  }
  // Replace votes
  await db.delete(pollVotes).where(and(eq(pollVotes.pollId, args.pollId), eq(pollVotes.userId, args.userId)));
  if (args.optionIds.length > 0) {
    await db.insert(pollVotes).values(args.optionIds.map((optionId) => ({ pollId: args.pollId, optionId, userId: args.userId })));
  }
  const pollData = await getPollData(args.pollId);
  return { ok: true, myVotes: args.optionIds, pollData };
}

export async function getPollData(pollId: string): Promise<PollData | null> {
  const [poll] = await db
    .select({ poll: polls, topicId: messages.topicId })
    .from(polls)
    .leftJoin(messages, eq(polls.messageId, messages.id))
    .where(eq(polls.id, pollId))
    .limit(1);
  if (!poll) return null;
  const opts = await db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).orderBy(asc(pollOptions.position));
  const voteRows = await db.select({ optionId: pollVotes.optionId }).from(pollVotes).where(eq(pollVotes.pollId, pollId));
  const vcMap = new Map<string, number>();
  for (const v of voteRows) vcMap.set(v.optionId, (vcMap.get(v.optionId) ?? 0) + 1);
  const totalVotes = Array.from(vcMap.values()).reduce((a, b) => a + b, 0);
  return {
    id: poll.poll.id,
    question: poll.poll.question,
    options: opts.map((o) => ({ id: o.id, text: o.text, position: o.position, voteCount: vcMap.get(o.id) ?? 0 })),
    isAnonymous: poll.poll.isAnonymous,
    allowsMultiple: poll.poll.allowsMultiple,
    isClosed: poll.poll.isClosed,
    totalVotes,
    topicId: poll.topicId ?? undefined,
  };
}

export async function getMyPollVotes(userId: string, pollIds: string[]): Promise<Record<string, string[]>> {
  if (pollIds.length === 0) return {};
  const rows = await db
    .select({ pollId: pollVotes.pollId, optionId: pollVotes.optionId })
    .from(pollVotes)
    .where(and(eq(pollVotes.userId, userId), inArray(pollVotes.pollId, pollIds)));
  const result: Record<string, string[]> = {};
  for (const row of rows) {
    const existing = result[row.pollId];
    if (!existing) { result[row.pollId] = [row.optionId]; }
    else { existing.push(row.optionId); }
  }
  return result;
}

export async function closePollById(pollId: string): Promise<{ ok: boolean; pollData: PollData | null }> {
  await db.update(polls).set({ isClosed: true }).where(eq(polls.id, pollId));
  const pollData = await getPollData(pollId);
  return { ok: true, pollData };
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

/**
 * Crypto-member resolver mirroring apps/web/lib/topic-members.ts. Used by the
 * topic-members live-update publisher so every connected TopicView can rotate
 * its Megolm session as soon as someone joins (rather than on next send).
 *
 *   member_user_ids → topic_members rows for this topic
 *   admin_user_ids  → role=admin, !isAnon, has ≥1 userKeyBundle (only for
 *                     is_e2ee topics; plain topics return [])
 */
async function listTopicCryptoMembers(
  topicId: string,
): Promise<{ memberUserIds: string[]; adminUserIds: string[] } | null> {
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

/**
 * Publish a topic membership change over the WS relay
 * (REDIS_CHANNELS.TOPIC_MEMBERS_UPDATED → WS_EVENTS.TOPIC_MEMBERS_UPDATED).
 *
 * Best-effort: a missed publish only delays the rotation until the next send,
 * which is the pre-change behaviour. We log and swallow.
 */
async function publishTopicMembersUpdated(args: {
  topicId: string;
  action: "join" | "leave";
  affectedUserId: string;
}): Promise<void> {
  try {
    const crypto = await listTopicCryptoMembers(args.topicId);
    if (!crypto) return;
    await pubClient.publish(
      REDIS_CHANNELS.TOPIC_MEMBERS_UPDATED,
      JSON.stringify({
        topicId: args.topicId,
        action: args.action,
        affectedUserId: args.affectedUserId,
        memberUserIds: crypto.memberUserIds,
        adminUserIds: crypto.adminUserIds,
      }),
    );
  } catch (err) {
    console.error("[topic-members] publish failed", { topicId: args.topicId, err });
  }
}

export async function ensureTopicMembership(userId: string, topicId: string): Promise<void> {
  // `.returning()` returns the inserted row, or [] if the conflict suppressed
  // the write. We use that to log a device_change ONLY on first join, so
  // re-opening a topic doesn't spam the change log.
  const inserted = await db
    .insert(topicMembers)
    .values({ topicId, userId })
    .onConflictDoNothing()
    .returning({ userId: topicMembers.userId });

  if (inserted.length > 0) {
    // Best-effort: a log miss only delays peers' device-list refresh on /sync.
    // Don't fail the join over it.
    try {
      await db.insert(userDeviceChangeLog).values({ userId, reason: "topic_join" });
    } catch (err) {
      console.error("[device-change-log] topic_join insert failed", { userId, topicId, err });
    }
    // Live key-rotation signal — only on the actual join, not the re-open
    // path. Subscribers in apps/ws/src/index.ts forward to topic:<id> so every
    // viewer can discard + reshare the Megolm session immediately.
    void publishTopicMembersUpdated({ topicId, action: "join", affectedUserId: userId });
  }
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

export async function getTopicById(topicId: string) {
  const [row] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
  return row ?? null;
}

export async function getTopicMemberUserIds(topicId: string): Promise<string[]> {
  const rows = await db.select({ userId: topicMembers.userId }).from(topicMembers).where(eq(topicMembers.topicId, topicId));
  return rows.map((r) => r.userId);
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

export async function getMessageOwner(messageId: string): Promise<{ topicId: string; senderUserId: string | null } | null> {
  const [row] = await db
    .select({ topicId: messages.topicId, senderUserId: messages.senderUserId })
    .from(messages)
    .where(and(eq(messages.id, BigInt(messageId)), isNull(messages.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function editMessage(args: {
  messageId: string;
  topicId: string;
  /** New plaintext (plain topics). Mutually exclusive with ciphertextJson. */
  newText?: string;
  /**
   * New Megolm envelope (E2EE topics). When provided, content_ciphertext
   * stays empty and ciphertext_json is replaced. messages_payload_chk still
   * holds: XOR (cipherJson IS NOT NULL) <> (octet_length(content_ciphertext) > 0).
   */
  newCiphertextJson?: Record<string, unknown>;
  editedByUserId: string;
}): Promise<InsertedMessage | null> {
  const [current] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, BigInt(args.messageId)), eq(messages.topicId, args.topicId), isNull(messages.deletedAt)))
    .limit(1);
  if (!current) return null;

  const isE2eeEdit = !!args.newCiphertextJson;
  const wasE2eeRow = !!current.ciphertextJson;
  // Must match the row's payload shape — refuse mixing.
  if (isE2eeEdit !== wasE2eeRow) return null;

  // Archive previous payload. For E2EE rows the byte columns are empty (the
  // payload lives in ciphertext_json); we still write the row to preserve the
  // edit-by-user / timestamp history. Schema has no jsonb column for prior
  // envelopes, so the envelope itself is not archived (acceptable: Megolm
  // ratchets forward and the prior payload is no longer needed).
  await db.insert(messageEdits).values({
    messageId: BigInt(args.messageId),
    editedByUserId: args.editedByUserId,
    previousContent: current.contentCiphertext,
    previousNonce: current.contentNonce,
    keyId: current.keyId,
  });

  const now = new Date();

  if (isE2eeEdit) {
    // Swap ciphertext_json; leave content_ciphertext/nonce as the existing
    // empty bytea (CHECK still passes).
    await db.update(messages)
      .set({ ciphertextJson: args.newCiphertextJson, editedAt: now })
      .where(eq(messages.id, BigInt(args.messageId)));
  } else {
    // Plaintext branch: re-encrypt envelope with current data key.
    const key = await currentDataKey();
    const aad = new TextEncoder().encode(args.topicId);
    const encoded = encodeContent(args.newText ?? "");
    const { ciphertext, nonce } = encryptMessage(key.data, encoded, aad);
    await db.update(messages)
      .set({ contentCiphertext: ciphertext, contentNonce: nonce, keyId: key.id, editedAt: now })
      .where(eq(messages.id, BigInt(args.messageId)));
  }

  let senderDisplayName: string | null = null;
  let senderAvatarUrl: string | null = null;
  let senderIsAnon = false;
  let senderRole: string | null = null;
  if (current.senderUserId) {
    const [u] = await db
      .select({ displayName: users.displayName, isAnon: users.isAnon, avatarUrl: users.avatarUrl, role: users.role })
      .from(users)
      .where(eq(users.id, current.senderUserId))
      .limit(1);
    if (u) { senderDisplayName = u.displayName; senderIsAnon = u.isAnon; senderAvatarUrl = u.avatarUrl; senderRole = u.role; }
  }

  const broadcastText = isE2eeEdit ? "" : (args.newText ?? "");
  const attachments = isE2eeEdit
    ? []
    : decodeContent(encodeContent(args.newText ?? "")).attachments;

  return {
    id: args.messageId,
    topicId: args.topicId,
    senderUserId: current.senderUserId,
    senderDisplayName,
    senderAvatarUrl,
    senderIsAnon,
    senderRole,
    botId: current.botId,
    replyToMessageId: current.replyToMessageId?.toString() ?? null,
    text: broadcastText,
    attachments,
    createdAt: current.createdAt,
    editedAt: now,
    ciphertextJson: isE2eeEdit ? args.newCiphertextJson! : null,
  };
}

export async function softDeleteMessage(messageId: string, topicId: string): Promise<boolean> {
  await db.update(messages)
    .set({ deletedAt: new Date() })
    .where(and(eq(messages.id, BigInt(messageId)), eq(messages.topicId, topicId), isNull(messages.deletedAt)));
  return true;
}

