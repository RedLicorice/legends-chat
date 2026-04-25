import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bots, topicBots, topics } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id: topicId } = await params;
  const rows = await db
    .select({ id: bots.id, name: bots.name, avatarUrl: bots.avatarUrl, webhookUrl: bots.webhookUrl, isActive: bots.isActive, addedAt: topicBots.addedAt })
    .from(topicBots)
    .innerJoin(bots, eq(topicBots.botId, bots.id))
    .where(eq(topicBots.topicId, topicId));
  return NextResponse.json(rows);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id: topicId } = await params;
  const [topic] = await db.select({ isE2ee: topics.isE2ee }).from(topics).where(eq(topics.id, topicId)).limit(1);
  if (!topic) return NextResponse.json({ error: "topic not found" }, { status: 404 });
  if (topic.isE2ee) return NextResponse.json({ error: "bots cannot be added to E2EE topics" }, { status: 400 });

  const body = await req.json() as { botId: string };
  if (!body.botId) return NextResponse.json({ error: "botId required" }, { status: 400 });

  const [bot] = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, body.botId), eq(bots.isActive, true))).limit(1);
  if (!bot) return NextResponse.json({ error: "bot not found or inactive" }, { status: 404 });

  await db.insert(topicBots).values({ botId: body.botId, topicId }).onConflictDoNothing();
  return NextResponse.json({ ok: true });
}
