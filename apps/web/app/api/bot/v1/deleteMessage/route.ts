import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { messages } from "@legends/db/schema";
import { REDIS_CHANNELS } from "@legends/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getBotFromRequest } from "@/lib/bot-auth";

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json() as { messageId: string };
  if (!body.messageId) return NextResponse.json({ ok: false, error: "messageId required" }, { status: 400 });

  const [msg] = await db.select({ id: messages.id, topicId: messages.topicId, botId: messages.botId })
    .from(messages)
    .where(and(eq(messages.id, BigInt(body.messageId)), eq(messages.botId, bot.id), isNull(messages.deletedAt)))
    .limit(1);
  if (!msg) return NextResponse.json({ ok: false, error: "message not found or not owned by bot" }, { status: 404 });

  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, BigInt(body.messageId)));

  await redis.publish(REDIS_CHANNELS.BOT_MESSAGE_DELETE, JSON.stringify({
    topicId: msg.topicId,
    id: body.messageId,
  }));

  return NextResponse.json({ ok: true });
}
