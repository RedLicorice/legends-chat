import { and, count, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { messageFlags, messages, topics, users } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { requireAnyAdmin } from "@/lib/auth-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireAnyAdmin([
    PERMISSIONS.MODERATION_QUEUE_REVIEW,
    PERMISSIONS.ADMIN_CONFIG,
  ]);
  if (gate instanceof NextResponse) return gate;

  const now = new Date();
  const h24 = new Date(now.getTime() - 86_400_000);
  const d7 = new Date(now.getTime() - 7 * 86_400_000);

  const [
    [pendingRow],
    [newUsers24hRow],
    [newUsers7dRow],
    onlineNow,
    topicList,
    msgs24h,
    msgs7d,
  ] = await Promise.all([
    db.select({ n: count() }).from(messageFlags).where(eq(messageFlags.status, "pending")),
    db.select({ n: count() }).from(users).where(and(gt(users.createdAt, h24), eq(users.isAnon, false))),
    db.select({ n: count() }).from(users).where(and(gt(users.createdAt, d7), eq(users.isAnon, false))),
    redis.scard("legends:online"),
    db.select({ id: topics.id, title: topics.title }).from(topics).orderBy(topics.sortOrder),
    db.select({ topicId: messages.topicId, n: count() })
      .from(messages)
      .where(and(isNull(messages.deletedAt), isNull(messages.botId), gt(messages.createdAt, h24)))
      .groupBy(messages.topicId),
    db.select({ topicId: messages.topicId, n: count() })
      .from(messages)
      .where(and(isNull(messages.deletedAt), isNull(messages.botId), gt(messages.createdAt, d7)))
      .groupBy(messages.topicId),
  ]);

  const msgs24hMap = new Map(msgs24h.map((r) => [r.topicId, Number(r.n)]));
  const msgs7dMap = new Map(msgs7d.map((r) => [r.topicId, Number(r.n)]));

  const topicActivity = topicList
    .map((t) => ({
      id: t.id,
      title: t.title,
      messages24h: msgs24hMap.get(t.id) ?? 0,
      messages7d: msgs7dMap.get(t.id) ?? 0,
    }))
    .sort((a, b) => b.messages24h - a.messages24h);

  return NextResponse.json({
    pendingFlags: Number(pendingRow?.n ?? 0),
    newUsers24h: Number(newUsers24hRow?.n ?? 0),
    newUsers7d: Number(newUsers7dRow?.n ?? 0),
    onlineNow,
    topicActivity,
  });
}
