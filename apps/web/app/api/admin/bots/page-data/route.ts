import { asc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bots, topics, topicBots } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireAdmin(PERMISSIONS.BOTS_MANAGE);
  if (gate instanceof NextResponse) return gate;

  const [botList, topicList, assignments] = await Promise.all([
    db
      .select({
        id: bots.id,
        name: bots.name,
        avatarUrl: bots.avatarUrl,
        description: bots.description,
        webhookUrl: bots.webhookUrl,
        isActive: bots.isActive,
        createdAt: bots.createdAt,
        role: bots.role,
        roleExpiresAt: bots.roleExpiresAt,
        roleFallback: bots.roleFallback,
      })
      .from(bots)
      .orderBy(bots.createdAt),
    db
      .select({ id: topics.id, title: topics.title, isE2ee: topics.isE2ee })
      .from(topics)
      .orderBy(asc(topics.sortOrder), asc(topics.title)),
    db.select({ botId: topicBots.botId, topicId: topicBots.topicId }).from(topicBots),
  ]);

  return NextResponse.json({ bots: botList, topics: topicList, assignments });
}
