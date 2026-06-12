import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bots, topicBots, topicMembers, topics } from "@legends/db/schema";
import { PERMISSIONS, BOT_E2EE_ERROR_CODES } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { logDeviceChange } from "@/lib/device-change-log";

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
  const [topic] = await db
    .select({ isE2ee: topics.isE2ee })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1);
  if (!topic) return NextResponse.json({ error: "topic not found" }, { status: 404 });

  const body = (await req.json()) as { botId: string };
  if (!body.botId) return NextResponse.json({ error: "botId required" }, { status: 400 });

  const [bot] = await db
    .select({ id: bots.id, e2eeState: bots.e2eeState })
    .from(bots)
    .where(and(eq(bots.id, body.botId), eq(bots.isActive, true)))
    .limit(1);
  if (!bot) return NextResponse.json({ error: "bot not found or inactive" }, { status: 404 });

  // E2EE topics require a 'ready' bot. The state machine guarantees the bot
  // has uploaded an Olm device + OTKs, so the OlmMachine on each existing
  // member can encrypt to it during the upcoming Megolm rotation.
  if (topic.isE2ee && bot.e2eeState !== "ready") {
    return NextResponse.json(
      { error: BOT_E2EE_ERROR_CODES.BOT_E2EE_REQUIRED },
      { status: 400 },
    );
  }

  await db.insert(topicBots).values({ botId: body.botId, topicId }).onConflictDoNothing();

  // Fan out a device-change row per topic member so their next /api/crypto/sync
  // surfaces this bot's device under device_lists.changed. OlmMachine treats
  // that as "membership changed" and rotates the outbound Megolm session,
  // re-targeting it at the (now-extended) device set. Without this nudge the
  // bot never receives a room key for the new session and stays unable to
  // decrypt traffic until an unrelated rotation event happens.
  if (topic.isE2ee) {
    const members = await db
      .select({ userId: topicMembers.userId })
      .from(topicMembers)
      .where(eq(topicMembers.topicId, topicId));
    for (const m of members) {
      await logDeviceChange(m.userId, `topic_bot_add:${body.botId}`);
    }
  }

  return NextResponse.json({ ok: true });
}
