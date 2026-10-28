// GET /api/bot/v1/rooms/[roomId]/members
//
// cr-h2 (bot-sdk parity): the independent roster @legends/bot-sdk cross-checks
// GET /api/bot/v1/crypto/rooms/[roomId]'s `members` against. Same room
// resolution and membership gate as that route, but a separately-coded query
// with no device/key-bundle assembly and no E2EE admin auto-add merge.

import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GET } from "@/app/api/bot/v1/rooms/[roomId]/members/route";
import { db } from "@/lib/db";
import {
  bots,
  botDevices,
  dmConversations,
  dmParticipants,
  topics,
  topicBots,
  topicMembers,
} from "@legends/db/schema";

let token: string;
let botId: string;
let otherBotId: string;
let userId: string;
let dmRoomId: string;
let topicRoomId: string;

async function get(roomId: string): Promise<Response> {
  return GET(
    new Request(`http://t/bot/v1/rooms/${encodeURIComponent(roomId)}/members`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ roomId }) },
  );
}

describe("/api/bot/v1/rooms/[roomId]/members", () => {
  beforeAll(async () => {
    userId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${userId}, 'crm') ON CONFLICT DO NOTHING`,
    );
    token = randomBytes(16).toString("hex");
    const [b] = await db
      .insert(bots)
      .values({
        name: `crm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: userId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        dmEnabled: true,
      })
      .returning({ id: bots.id });
    botId = b!.id;
    await db.insert(botDevices).values({
      botId,
      deviceId: "BCRM",
      algorithms: ["a"],
      identityKeys: { "ed25519:BCRM": "ed" },
    });

    const [ob] = await db
      .insert(bots)
      .values({
        name: `crm-other-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: userId,
        tokenHash: createHash("sha256").update(randomBytes(16).toString("hex")).digest("hex"),
        dmEnabled: true,
      })
      .returning({ id: bots.id });
    otherBotId = ob!.id;

    // DM room: bot is a participant.
    const dmId = randomUUID();
    await db.insert(dmConversations).values({
      id: dmId,
      dmKey: `u:${userId}|b:${botId}|${Date.now()}-${Math.random().toString(36).slice(2)}`,
      isE2ee: true,
      state: "accepted",
      initiatorType: "user",
      initiatorId: userId,
      e2eeRoomId: `!${dmId}:legends.local`,
    });
    await db.insert(dmParticipants).values([
      { conversationId: dmId, principalType: "user", principalId: userId },
      { conversationId: dmId, principalType: "bot", principalId: botId },
    ]);
    dmRoomId = `!${dmId}:legends.local`;

    // Topic room: both bots are in topic_bots, plus one human member.
    const [t] = await db
      .insert(topics)
      .values({
        slug: `crtm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title: "crtm",
        isE2ee: true,
        historyVisibleToNewMembers: false,
      })
      .returning({ id: topics.id });
    await db
      .update(topics)
      .set({ e2eeRoomId: `!${t!.id}:legends.local` })
      .where(sql`${topics.id} = ${t!.id}`);
    await db.insert(topicMembers).values({ topicId: t!.id, userId });
    await db.insert(topicBots).values([
      { topicId: t!.id, botId },
      { topicId: t!.id, botId: otherBotId },
    ]);
    topicRoomId = `!${t!.id}:legends.local`;
  });

  it("returns the user roster for a DM room where the bot participates", async () => {
    const res = await get(dmRoomId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matrix_ids).toContain(`@${userId}:legends.local`);
    // The bot itself is excluded from its own room's roster, same as the
    // crypto-rooms endpoint it's cross-checked against.
    expect(body.matrix_ids).not.toContain(`@bot.${botId}:legends.local`);
  });

  it("returns the user + other-bot roster for a topic room, excluding the calling bot", async () => {
    const res = await get(topicRoomId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matrix_ids).toContain(`@${userId}:legends.local`);
    expect(body.matrix_ids).toContain(`@bot.${otherBotId}:legends.local`);
    expect(body.matrix_ids).not.toContain(`@bot.${botId}:legends.local`);
  });

  it("403 when the bot is not a member of the resolved room", async () => {
    const otherTopicId = randomUUID();
    await db.insert(topics).values({
      id: otherTopicId,
      slug: `cro-m-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: "x",
      isE2ee: true,
      historyVisibleToNewMembers: false,
      e2eeRoomId: `!${otherTopicId}:legends.local`,
    });
    const res = await get(`!${otherTopicId}:legends.local`);
    expect(res.status).toBe(403);
  });

  it("404 when the room id parses but the UUID isn't a DM or topic", async () => {
    const ghostId = randomUUID();
    const res = await get(`!${ghostId}:legends.local`);
    expect(res.status).toBe(404);
  });

  it("400 on malformed room id", async () => {
    const res = await get("not-a-matrix-room");
    expect(res.status).toBe(400);
  });

  it("401 when bearer is missing", async () => {
    const res = await GET(
      new Request(`http://t/bot/v1/rooms/${encodeURIComponent(dmRoomId)}/members`),
      { params: Promise.resolve({ roomId: dmRoomId }) },
    );
    expect(res.status).toBe(401);
  });
});
