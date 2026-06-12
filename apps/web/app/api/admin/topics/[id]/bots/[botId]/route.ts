import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { topicBots, topicMembers, topics } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { logDeviceChange } from "@/lib/device-change-log";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; botId: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id: topicId, botId } = await params;
  await db
    .delete(topicBots)
    .where(and(eq(topicBots.topicId, topicId), eq(topicBots.botId, botId)));

  // For E2EE topics, drop a device-change row per remaining member so the
  // outbound Megolm session rotates and excludes the removed bot's device
  // going forward. (Symmetric to the add path; see comment in POST.)
  const [topic] = await db
    .select({ isE2ee: topics.isE2ee })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1);
  if (topic?.isE2ee) {
    const members = await db
      .select({ userId: topicMembers.userId })
      .from(topicMembers)
      .where(eq(topicMembers.topicId, topicId));
    for (const m of members) {
      await logDeviceChange(m.userId, `topic_bot_remove:${botId}`);
    }
  }

  return NextResponse.json({ ok: true });
}
