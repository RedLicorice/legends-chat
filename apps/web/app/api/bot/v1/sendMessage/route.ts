import { and, eq, gt, isNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  dmConversations, dmParticipants,
  encryptionKeys, messages, topicBots, topicPrincipalGrants, topics,
} from "@legends/db/schema";
import { canPrincipal, REDIS_CHANNELS, type GrantEffect, type TopicGrant } from "@legends/shared";
import { encryptMessage, unwrapKey, generateDataKey, wrapKey } from "@legends/crypto";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getBotFromRequest } from "@/lib/bot-auth";
import { insertDmMessage } from "@/lib/dm";

interface InlineKeyboardButton { text: string; callbackData: string }

// R2 (bot E2EE part 1 / Task 13): this route now accepts `ciphertext` next to
// `text` for E2EE DM conversations. Topic branch still requires `text` (Part 1
// only covers DM E2EE; topic-bot E2EE has its own follow-up). DM mode/payload
// pairing is enforced post-conv-lookup:
//   - E2EE convo ⇒ ciphertext required (text rejected)
//   - Plaintext convo ⇒ text required (ciphertext rejected)

let cachedKey: { id: string; data: Uint8Array } | null = null;
async function currentDataKey(): Promise<{ id: string; data: Uint8Array }> {
  if (cachedKey) return cachedKey;
  const { desc } = await import("drizzle-orm");
  const rows = await db.select().from(encryptionKeys).where(eq(encryptionKeys.purpose, "messages")).orderBy(desc(encryptionKeys.createdAt)).limit(1);
  if (rows[0]) {
    cachedKey = { id: rows[0].id, data: unwrapKey(rows[0].wrappedKey) };
    return cachedKey;
  }
  const data = generateDataKey();
  const { wrapped } = wrapKey(data);
  const [inserted] = await db.insert(encryptionKeys).values({ purpose: "messages", wrappedKey: wrapped }).returning();
  cachedKey = { id: inserted!.id, data };
  return cachedKey;
}

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json() as {
    topicId?: string;
    conversationId?: string;
    text?: string;
    // Per the wire-format contract (see olm-machine.ts) `ciphertext` is a
    // JSON-stringified m.room.encrypted CONTENT object on the bot API.
    ciphertext?: string;
    replyToMessageId?: string;
    inlineKeyboard?: InlineKeyboardButton[][];
  };
  if ((body.topicId && body.conversationId) || (!body.topicId && !body.conversationId)) {
    return NextResponse.json({ ok: false, error: "exactly one of topicId or conversationId required" }, { status: 400 });
  }
  // text XOR ciphertext at the request level. The conv-mode match is
  // enforced after we know `isE2ee` (DM branch only — topic branch still
  // requires text).
  const hasText = typeof body.text === "string" && body.text.trim().length > 0;
  // Parse ciphertext into a jsonb object now — the wire field is a string but
  // dm_messages.ciphertext_json is jsonb. Rejecting non-string / non-parseable
  // bodies here is what catches the legacy object shape (the live-stack bug).
  let ciphertextJson: Record<string, unknown> | null = null;
  if (body.ciphertext != null) {
    if (typeof body.ciphertext !== "string") {
      return NextResponse.json(
        { ok: false, error: "ciphertext must be a JSON-stringified string" },
        { status: 400 },
      );
    }
    try {
      const parsed = JSON.parse(body.ciphertext) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return NextResponse.json(
          { ok: false, error: "ciphertext must parse to a JSON object" },
          { status: 400 },
        );
      }
      ciphertextJson = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { ok: false, error: "ciphertext must parse to a JSON object" },
        { status: 400 },
      );
    }
  }
  const hasCiphertext = ciphertextJson != null;
  if (hasText === hasCiphertext) {
    return NextResponse.json(
      { ok: false, error: "exactly one of `text` or `ciphertext` required" },
      { status: 400 },
    );
  }

  // ── DM branch ──────────────────────────────────────────────────────────────
  if (body.conversationId) {
    const [conv] = await db.select().from(dmConversations).where(eq(dmConversations.id, body.conversationId)).limit(1);
    if (!conv) return NextResponse.json({ ok: false, error: "conversation not found" }, { status: 404 });
    if (conv.state === "blocked") return NextResponse.json({ ok: false, error: "blocked" }, { status: 403 });

    const [part] = await db
      .select({ pid: dmParticipants.principalId })
      .from(dmParticipants)
      .where(and(
        eq(dmParticipants.conversationId, body.conversationId),
        eq(dmParticipants.principalType, "bot"),
        eq(dmParticipants.principalId, bot.id),
      ))
      .limit(1);
    if (!part) return NextResponse.json({ ok: false, error: "bot not in conversation" }, { status: 403 });

    if (body.inlineKeyboard && body.inlineKeyboard.length > 0) {
      return NextResponse.json({ ok: false, error: "inline keyboards not supported in DMs (yet)" }, { status: 400 });
    }

    // Mode/payload match: E2EE convo wants ciphertext, plaintext wants text.
    if (conv.isE2ee && !hasCiphertext) {
      return NextResponse.json(
        { ok: false, error: "E2EE conversation; send ciphertext" },
        { status: 400 },
      );
    }
    if (!conv.isE2ee && !hasText) {
      return NextResponse.json(
        { ok: false, error: "plaintext conversation; send text" },
        { status: 400 },
      );
    }

    const msg = await insertDmMessage({
      conversationId: body.conversationId,
      senderType: "bot",
      senderId: bot.id,
      text: hasText ? body.text!.trim() : undefined,
      ciphertext: ciphertextJson ?? undefined,
      replyToMessageId:
        body.replyToMessageId && /^\d+$/.test(body.replyToMessageId)
          ? body.replyToMessageId
          : null,
    });

    // Fan out to user participants via the existing ws relay (Plan A path).
    const userParts = await db
      .select({ pid: dmParticipants.principalId })
      .from(dmParticipants)
      .where(and(eq(dmParticipants.conversationId, body.conversationId), eq(dmParticipants.principalType, "user")));
    const userIds = userParts.map((p) => p.pid);
    await redis.publish(
      REDIS_CHANNELS.DM_MESSAGE_NEW,
      JSON.stringify({
        conversationId: body.conversationId,
        message: msg,
        userIds,
        isE2ee: conv.isE2ee,
      }),
    );

    return NextResponse.json({ ok: true, result: { messageId: msg.id } }, { status: 201 });
  }

  // ── Topic branch (existing behavior, unchanged) ────────────────────────────
  // Topic posts still require plaintext `text` — Part 1 only opens DM E2EE,
  // topic-bot E2EE has its own follow-up sub-project.
  if (!hasText) {
    return NextResponse.json(
      { ok: false, error: "ciphertext not supported for topic posts" },
      { status: 400 },
    );
  }
  const topicId = body.topicId!;
  const [topic] = await db.select({ isE2ee: topics.isE2ee }).from(topics).where(eq(topics.id, topicId)).limit(1);
  if (!topic) return NextResponse.json({ ok: false, error: "topic not found" }, { status: 404 });
  if (topic.isE2ee) return NextResponse.json({ ok: false, error: "bots cannot send to E2EE topics" }, { status: 400 });

  const [assignment] = await db.select().from(topicBots).where(and(eq(topicBots.botId, bot.id), eq(topicBots.topicId, topicId))).limit(1);
  if (!assignment) return NextResponse.json({ ok: false, error: "bot not assigned to topic" }, { status: 403 });

  const now = new Date();
  const grantRows = await db
    .select({ action: topicPrincipalGrants.action, effect: topicPrincipalGrants.effect })
    .from(topicPrincipalGrants)
    .where(and(
      eq(topicPrincipalGrants.topicId, topicId),
      eq(topicPrincipalGrants.principalType, "bot"),
      eq(topicPrincipalGrants.principalId, bot.id),
      or(isNull(topicPrincipalGrants.expiresAt), gt(topicPrincipalGrants.expiresAt, now)),
    ));
  const grants: TopicGrant[] = grantRows.map((g) => ({ action: g.action, effect: g.effect as GrantEffect }));
  const isReply = !!body.replyToMessageId;
  const [topicDetail] = await db.select({ postRoles: topics.postRoles, replyRoles: topics.replyRoles, isFeed: topics.isFeed }).from(topics).where(eq(topics.id, topicId)).limit(1);
  const actionRoles = isReply && topicDetail?.isFeed
    ? ((topicDetail?.replyRoles as string[] | null) ?? [])
    : ((topicDetail?.postRoles as string[] | null) ?? []);
  const action = isReply && topicDetail?.isFeed ? "reply" : "post";
  if (!canPrincipal(grants, actionRoles, bot.role, action)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const key = await currentDataKey();
  const aad = new TextEncoder().encode(topicId);
  const { ciphertext, nonce } = encryptMessage(key.data, body.text!.trim(), aad);
  const [row] = await db.insert(messages).values({
    topicId,
    senderUserId: null,
    botId: bot.id,
    replyToMessageId: body.replyToMessageId ? BigInt(body.replyToMessageId) : null,
    contentCiphertext: ciphertext,
    contentNonce: nonce,
    keyId: key.id,
    inlineKeyboard: body.inlineKeyboard ?? null,
  }).returning();

  const msgOut = {
    id: row!.id.toString(),
    topicId: row!.topicId,
    senderUserId: null,
    senderDisplayName: bot.name,
    senderAvatarUrl: bot.avatarUrl,
    senderIsAnon: false,
    botId: bot.id,
    replyToMessageId: row!.replyToMessageId?.toString() ?? null,
    text: body.text!.trim(),
    attachments: [],
    inlineKeyboard: body.inlineKeyboard ?? null,
    createdAt: row!.createdAt,
    editedAt: null,
  };
  await redis.publish(REDIS_CHANNELS.BOT_MESSAGE_NEW, JSON.stringify({ topicId, message: msgOut }));
  return NextResponse.json({ ok: true, result: { messageId: row!.id.toString() } }, { status: 201 });
}
