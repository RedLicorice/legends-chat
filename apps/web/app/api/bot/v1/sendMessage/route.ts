import { and, eq, gt, isNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { encryptionKeys, messages, topicBots, topicPrincipalGrants, topics, users } from "@legends/db/schema";
import { canPrincipal, REDIS_CHANNELS, type GrantEffect, type TopicGrant } from "@legends/shared";
import { encryptMessage, unwrapKey, generateDataKey, wrapKey } from "@legends/crypto";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getBotFromRequest } from "@/lib/bot-auth";

interface InlineKeyboardButton { text: string; callbackData: string }

async function currentDataKey(): Promise<{ id: string; data: Uint8Array }> {
  const { desc } = await import("drizzle-orm");
  const rows = await db.select().from(encryptionKeys).where(eq(encryptionKeys.purpose, "messages")).orderBy(desc(encryptionKeys.createdAt)).limit(1);
  if (rows[0]) return { id: rows[0].id, data: unwrapKey(rows[0].wrappedKey) };
  const data = generateDataKey();
  const { wrapped } = wrapKey(data);
  const [inserted] = await db.insert(encryptionKeys).values({ purpose: "messages", wrappedKey: wrapped }).returning();
  return { id: inserted!.id, data };
}

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json() as {
    topicId: string;
    text: string;
    replyToMessageId?: string;
    inlineKeyboard?: InlineKeyboardButton[][];
  };
  if (!body.topicId || !body.text?.trim()) {
    return NextResponse.json({ ok: false, error: "topicId and text required" }, { status: 400 });
  }

  const [topic] = await db.select({ isE2ee: topics.isE2ee }).from(topics).where(eq(topics.id, body.topicId)).limit(1);
  if (!topic) return NextResponse.json({ ok: false, error: "topic not found" }, { status: 404 });
  if (topic.isE2ee) return NextResponse.json({ ok: false, error: "bots cannot send to E2EE topics" }, { status: 400 });

  const [assignment] = await db.select().from(topicBots).where(and(eq(topicBots.botId, bot.id), eq(topicBots.topicId, body.topicId))).limit(1);
  if (!assignment) return NextResponse.json({ ok: false, error: "bot not assigned to topic" }, { status: 403 });

  const now = new Date();
  const grantRows = await db
    .select({ action: topicPrincipalGrants.action, effect: topicPrincipalGrants.effect })
    .from(topicPrincipalGrants)
    .where(
      and(
        eq(topicPrincipalGrants.topicId, body.topicId),
        eq(topicPrincipalGrants.principalType, "bot"),
        eq(topicPrincipalGrants.principalId, bot.id),
        or(isNull(topicPrincipalGrants.expiresAt), gt(topicPrincipalGrants.expiresAt, now)),
      ),
    );
  const grants: TopicGrant[] = grantRows.map((g) => ({ action: g.action, effect: g.effect as GrantEffect }));
  const isReply = !!body.replyToMessageId;
  const [topicDetail] = await db.select({ postRoles: topics.postRoles, replyRoles: topics.replyRoles, isFeed: topics.isFeed }).from(topics).where(eq(topics.id, body.topicId)).limit(1);
  const actionRoles = isReply && topicDetail?.isFeed
    ? ((topicDetail?.replyRoles as string[] | null) ?? [])
    : ((topicDetail?.postRoles as string[] | null) ?? []);
  const action = isReply && topicDetail?.isFeed ? "reply" : "post";
  if (!canPrincipal(grants, actionRoles, bot.role, action)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const key = await currentDataKey();
  const aad = new TextEncoder().encode(body.topicId);
  const { ciphertext, nonce } = encryptMessage(key.data, body.text.trim(), aad);

  const [row] = await db.insert(messages).values({
    topicId: body.topicId,
    senderUserId: null,
    botId: bot.id,
    replyToMessageId: body.replyToMessageId ? BigInt(body.replyToMessageId) : null,
    contentCiphertext: ciphertext,
    contentNonce: nonce,
    keyId: key.id,
    inlineKeyboard: body.inlineKeyboard ?? null,
  }).returning();

  // Fetch bot display info for WS broadcast
  const [botUser] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, bot.ownerUserId)).limit(1);

  const msgOut = {
    id: row!.id.toString(),
    topicId: row!.topicId,
    senderUserId: null,
    senderDisplayName: bot.name,
    senderAvatarUrl: bot.avatarUrl,
    senderIsAnon: false,
    botId: bot.id,
    replyToMessageId: row!.replyToMessageId?.toString() ?? null,
    text: body.text.trim(),
    attachments: [],
    inlineKeyboard: body.inlineKeyboard ?? null,
    createdAt: row!.createdAt,
    editedAt: null,
  };

  await redis.publish(REDIS_CHANNELS.BOT_MESSAGE_NEW, JSON.stringify({ topicId: body.topicId, message: msgOut }));

  return NextResponse.json({ ok: true, result: { messageId: row!.id.toString() } }, { status: 201 });
}
