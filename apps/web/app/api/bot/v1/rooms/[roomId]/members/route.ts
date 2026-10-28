// GET /api/bot/v1/rooms/[roomId]/members
//
// cr-h2 (bot-sdk parity): plain, independently-coded participant roster for
// a bot's DM or topic room — the second source @legends/bot-sdk cross-checks
// GET /api/bot/v1/crypto/rooms/[roomId]'s `members` against before handing
// anything to `shareRoomKey`. Mirrors the human client's dual-source check
// (crypto/rooms/<id>/members vs. the plain /api/topics/<id>/members roster):
// without an independent second source, a compromised crypto-rooms handler
// could add a phantom id to `members` and the bot would wrap the Megolm
// session key for it with no way to notice.
//
// Deliberately does NOT join userKeyBundles / botDevices (no device-list
// assembly) and does NOT merge in E2EE admin auto-add — bots never get that
// merge in the first place (see crypto/rooms/[roomId]'s own comment: it
// queries topic_members / topic_bots directly, same as here). This is just
// those same rows, read through a separately-written query.
//
// Same membership gate as crypto/rooms/[roomId]: the bot must already be a
// topic_bots / dm_participants row for this room.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  dmConversations,
  dmParticipants,
  topics,
  topicBots,
  topicMembers,
} from "@legends/db/schema";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";
import { fromMatrixRoomId, toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";

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

  // DM room first — same cheap-index-hit ordering as crypto/rooms/[roomId].
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
    const isBotMember = parts.some((p) => p.pt === "bot" && p.pid === bot.id);
    if (!isBotMember) {
      return NextResponse.json(
        { errcode: "forbidden", error: "not a member" },
        { status: 403 },
      );
    }
    const matrixIds = parts
      .filter((p) => !(p.pt === "bot" && p.pid === bot.id))
      .map((p) => (p.pt === "user" ? toMatrixUserId(p.pid) : toMatrixBotId(p.pid)));
    return NextResponse.json({ matrix_ids: matrixIds });
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
    const botRows = await db
      .select({ botId: topicBots.botId })
      .from(topicBots)
      .where(eq(topicBots.topicId, topic.id));
    const matrixIds = [
      ...userRows.map((u) => toMatrixUserId(u.userId)),
      ...botRows.filter((b) => b.botId !== bot.id).map((b) => toMatrixBotId(b.botId)),
    ];
    return NextResponse.json({ matrix_ids: matrixIds });
  }

  return NextResponse.json(
    { errcode: "not_found", error: "room not found" },
    { status: 404 },
  );
}
