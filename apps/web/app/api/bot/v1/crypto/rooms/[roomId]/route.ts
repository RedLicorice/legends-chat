// GET /api/bot/v1/crypto/rooms/[roomId]
//
// Bot-authenticated room-member listing. The bot SDK calls this to learn
// which device sets it must encrypt for in a given DM or topic room. The
// route parses the synthetic Matrix room id `!<uuid>:legends.local`, then
// looks the UUID up in dm_conversations first then topics (DM id space is
// distinct from topic id space — a UUID collision would be astronomical, but
// dm_conversations check goes first as it's the cheaper index hit).
//
// Membership gate: bot must be either a dm_participants row (DM) or a
// topic_bots row (topic). The bot itself is intentionally omitted from the
// response so the OlmMachine doesn't try to encrypt for its own device.

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import {
  botDevices,
  dmConversations,
  dmParticipants,
  topics,
  topicBots,
  topicMembers,
  userKeyBundles,
} from "@legends/db/schema";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";
import { fromMatrixRoomId, toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";

type ParticipantEntry =
  | { pt: "user"; pid: string }
  | { pt: "bot"; pid: string };

export async function GET(
  req: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const bot = await getBotFromRequest(req);
  if (!bot) {
    return NextResponse.json(
      { errcode: "unauthorized", error: "unauthorized" },
      { status: 401 },
    );
  }

  const { roomId } = await params;
  const decoded = decodeURIComponent(roomId);
  const inner = fromMatrixRoomId(decoded);
  if (!inner) {
    return NextResponse.json(
      { errcode: "bad_room_id", error: "invalid room id" },
      { status: 400 },
    );
  }

  // DM room first.
  const [dm] = await db
    .select({ id: dmConversations.id })
    .from(dmConversations)
    .where(eq(dmConversations.id, inner))
    .limit(1);
  if (dm) {
    const parts = await db
      .select({
        pt: dmParticipants.principalType,
        pid: dmParticipants.principalId,
      })
      .from(dmParticipants)
      .where(eq(dmParticipants.conversationId, dm.id));
    const isBotMember = parts.some(
      (p) => p.pt === "bot" && p.pid === bot.id,
    );
    if (!isBotMember) {
      return NextResponse.json(
        { errcode: "forbidden", error: "not a member" },
        { status: 403 },
      );
    }
    const others: ParticipantEntry[] = parts
      .filter((p) => !(p.pt === "bot" && p.pid === bot.id))
      .map((p) =>
        p.pt === "user"
          ? { pt: "user", pid: p.pid }
          : { pt: "bot", pid: p.pid },
      );
    const members = await assembleMembers(others);
    return NextResponse.json({ members });
  }

  // Topic room.
  const [topic] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.id, inner))
    .limit(1);
  if (topic) {
    const [membership] = await db
      .select({ botId: topicBots.botId })
      .from(topicBots)
      .where(and(eq(topicBots.topicId, topic.id), eq(topicBots.botId, bot.id)))
      .limit(1);
    if (!membership) {
      return NextResponse.json(
        { errcode: "forbidden", error: "not a member" },
        { status: 403 },
      );
    }
    const userRows = await db
      .select({ userId: topicMembers.userId })
      .from(topicMembers)
      .where(eq(topicMembers.topicId, topic.id));
    const otherBotRows = await db
      .select({ botId: topicBots.botId })
      .from(topicBots)
      .where(eq(topicBots.topicId, topic.id));
    const others: ParticipantEntry[] = [
      ...userRows.map<ParticipantEntry>((u) => ({ pt: "user", pid: u.userId })),
      ...otherBotRows
        .filter((b) => b.botId !== bot.id)
        .map<ParticipantEntry>((b) => ({ pt: "bot", pid: b.botId })),
    ];
    const members = await assembleMembers(others);
    return NextResponse.json({ members });
  }

  return NextResponse.json(
    { errcode: "not_found", error: "room not found" },
    { status: 404 },
  );
}

async function assembleMembers(
  parts: ParticipantEntry[],
): Promise<{ matrix_id: string; devices: string[] }[]> {
  const userIds = parts.filter((p) => p.pt === "user").map((p) => p.pid);
  const botIds = parts.filter((p) => p.pt === "bot").map((p) => p.pid);

  const userDevs = userIds.length
    ? await db
        .select({
          userId: userKeyBundles.userId,
          deviceId: userKeyBundles.deviceId,
        })
        .from(userKeyBundles)
        .where(inArray(userKeyBundles.userId, userIds))
    : [];
  const botDevs = botIds.length
    ? await db
        .select({ botId: botDevices.botId, deviceId: botDevices.deviceId })
        .from(botDevices)
        .where(inArray(botDevices.botId, botIds))
    : [];

  const byUser = new Map<string, string[]>();
  for (const r of userDevs) {
    byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.deviceId]);
  }
  const byBot = new Map<string, string[]>();
  for (const r of botDevs) {
    byBot.set(r.botId, [...(byBot.get(r.botId) ?? []), r.deviceId]);
  }

  const out: { matrix_id: string; devices: string[] }[] = [];
  for (const uid of userIds) {
    out.push({ matrix_id: toMatrixUserId(uid), devices: byUser.get(uid) ?? [] });
  }
  for (const bid of botIds) {
    out.push({ matrix_id: toMatrixBotId(bid), devices: byBot.get(bid) ?? [] });
  }
  return out;
}
