import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { topicBots } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; botId: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id: topicId, botId } = await params;
  await db.delete(topicBots).where(and(eq(topicBots.topicId, topicId), eq(topicBots.botId, botId)));
  return NextResponse.json({ ok: true });
}
