// GET /api/bot/v1/crypto/rooms/[roomId]
//
// Task 12: bot-authenticated room-members listing. Parses the matrix room id
// `!<uuid>:legends.local`, resolves the UUID against dm_conversations.id then
// topics.id, gates on bot participation in the resolved room, and returns a
// members[] array of { matrix_id, devices: string[] }. The bot itself is
// omitted from the response so the OlmMachine doesn't try to encrypt for its
// own device.

import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GET } from "@/app/api/bot/v1/crypto/rooms/[roomId]/route";
import { db } from "@/lib/db";
import {
  bots,
  botDevices,
  dmConversations,
  dmParticipants,
  topics,
  topicBots,
  topicMembers,
  userKeyBundles,
} from "@legends/db/schema";

let token: string;
let botId: string;
let userId: string;
let dmRoomId: string;
let topicRoomId: string;

async function get(roomId: string): Promise<Response> {
  return GET(
    new Request(`http://t/bot/v1/crypto/rooms/${encodeURIComponent(roomId)}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ roomId }) },
  );
}

describe("/api/bot/v1/crypto/rooms/[roomId]", () => {
  beforeAll(async () => {
    userId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${userId}, 'cr') ON CONFLICT DO NOTHING`,
    );
    await db.insert(userKeyBundles).values({
      userId,
      deviceId: "UCR",
      identityPublicKey: "ed",
      algorithmsJson: ["a"],
      keysJson: { "ed25519:UCR": "ed" },
      signaturesJson: { [`@${userId}:legends.local`]: { "ed25519:UCR": "s" } },
    });
    token = randomBytes(16).toString("hex");
    const [b] = await db
      .insert(bots)
      .values({
        name: `cr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ownerUserId: userId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        dmEnabled: true,
      })
      .returning({ id: bots.id });
    botId = b!.id;
    await db.insert(botDevices).values({
      botId,
      deviceId: "BCR",
      algorithms: ["a"],
      identityKeys: { "ed25519:BCR": "ed" },
    });

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

    // Topic room: bot is in topic_bots.
    const [t] = await db
      .insert(topics)
      .values({
        slug: `crt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title: "crt",
        isE2ee: true,
        historyVisibleToNewMembers: false,
      })
      .returning({ id: topics.id });
    await db
      .update(topics)
      .set({ e2eeRoomId: `!${t!.id}:legends.local` })
      .where(sql`${topics.id} = ${t!.id}`);
    await db.insert(topicMembers).values({ topicId: t!.id, userId });
    await db.insert(topicBots).values({ topicId: t!.id, botId });
    topicRoomId = `!${t!.id}:legends.local`;
  });

  it("returns user members for a DM room where the bot participates", async () => {
    const res = await get(dmRoomId);
    expect(res.status).toBe(200);
    const body = await res.json();
    const matrixIds = body.members.map((m: { matrix_id: string }) => m.matrix_id);
    expect(matrixIds).toContain(`@${userId}:legends.local`);
    // The bot itself should not appear in its own room members response.
    expect(matrixIds).not.toContain(`@bot.${botId}:legends.local`);
    // Devices should be populated from user_key_bundles.
    const userEntry = body.members.find(
      (m: { matrix_id: string }) => m.matrix_id === `@${userId}:legends.local`,
    );
    expect(userEntry.devices).toContain("UCR");
  });

  it("returns members for a topic room where the bot is in topic_bots", async () => {
    const res = await get(topicRoomId);
    expect(res.status).toBe(200);
    const body = await res.json();
    const matrixIds = body.members.map((m: { matrix_id: string }) => m.matrix_id);
    expect(matrixIds).toContain(`@${userId}:legends.local`);
    expect(matrixIds).not.toContain(`@bot.${botId}:legends.local`);
  });

  it("403 when the bot is not a member of the resolved room", async () => {
    const otherTopicId = randomUUID();
    await db.insert(topics).values({
      id: otherTopicId,
      slug: `cro-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
      new Request(`http://t/bot/v1/crypto/rooms/${encodeURIComponent(dmRoomId)}`),
      { params: Promise.resolve({ roomId: dmRoomId }) },
    );
    expect(res.status).toBe(401);
  });
});
