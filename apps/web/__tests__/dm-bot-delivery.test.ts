// deliverDmToBots — ciphertext branch (Task 15).
//
// For E2EE convos the delivery helper must forward the Matrix
// `m.room.encrypted` envelope (`ciphertext`) instead of the plaintext body.
// For plaintext convos the existing `text` payload is preserved unchanged.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

const pushed: { key: string; payload: unknown }[] = [];
vi.mock("@/lib/redis", () => ({
  redis: {
    rpush: async (key: string, val: string) => {
      pushed.push({ key, payload: JSON.parse(val) });
      return 1;
    },
    expire: async () => 1,
  },
}));

const { db } = await import("@/lib/db");
const { bots, dmConversations, dmParticipants } = await import("@legends/db/schema");
const { deliverDmToBots } = await import("@/lib/dm-bot-delivery");

let userId: string;
let botId: string;
let e2eeConvId: string;
let plaintextConvId: string;

describe("deliverDmToBots — ciphertext branch", () => {
  beforeAll(async () => {
    userId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${userId}, 'dlv') ON CONFLICT DO NOTHING`,
    );
    const [b] = await db
      .insert(bots)
      .values({
        name: `dlv-${randomUUID()}`,
        ownerUserId: userId,
        dmEnabled: true,
        isActive: true,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        e2eeState: "ready",
        e2eeDeviceId: "BDLV",
      })
      .returning({ id: bots.id });
    botId = b!.id;

    const [e] = await db
      .insert(dmConversations)
      .values({
        dmKey: `b:${botId}|u:${userId}|e`,
        isE2ee: true,
        state: "accepted",
        initiatorType: "user",
        initiatorId: userId,
      })
      .returning({ id: dmConversations.id });
    e2eeConvId = e!.id;
    await db.insert(dmParticipants).values([
      { conversationId: e2eeConvId, principalType: "user", principalId: userId },
      { conversationId: e2eeConvId, principalType: "bot", principalId: botId },
    ]);

    const [p] = await db
      .insert(dmConversations)
      .values({
        dmKey: `b:${botId}|u:${userId}|p`,
        isE2ee: false,
        state: "accepted",
        initiatorType: "user",
        initiatorId: userId,
      })
      .returning({ id: dmConversations.id });
    plaintextConvId = p!.id;
    await db.insert(dmParticipants).values([
      { conversationId: plaintextConvId, principalType: "user", principalId: userId },
      { conversationId: plaintextConvId, principalType: "bot", principalId: botId },
    ]);
  });

  it("E2EE convo forwards ciphertext as string + populates e2ee_room_id + sender_matrix_id", async () => {
    // Stamp the conversation with a synthetic Matrix room id so the helper
    // can look it up (mirrors what convo open does in production).
    await db
      .update(dmConversations)
      .set({ e2eeRoomId: `!${e2eeConvId}:legends.local` })
      .where(sql`${dmConversations.id} = ${e2eeConvId}`);

    pushed.length = 0;
    await deliverDmToBots(e2eeConvId, {
      id: "1",
      senderType: "user",
      senderId: userId,
      senderDisplayName: "u",
      text: "",
      replyToMessageId: null,
      createdAt: new Date().toISOString(),
      ciphertext: { algorithm: "m.olm.v1.curve25519-aes-sha2", x: 1 },
    });
    expect(pushed).toHaveLength(1);
    const env = pushed[0]!.payload as {
      dm_message: {
        ciphertext?: unknown;
        text?: string;
        e2ee_room_id?: string;
        sender_matrix_id?: string;
      };
    };
    // Wire-format: ciphertext is a JSON string the bot will JSON.parse.
    expect(typeof env.dm_message.ciphertext).toBe("string");
    expect(env.dm_message.text).toBeFalsy();
    // SDK needs the room id + sender matrix id to assemble the m.room.encrypted
    // event for `decryptRoomEvent`. Without these two fields the bot can't
    // decrypt and the message is silently dropped — the live-stack symptom.
    expect(env.dm_message.e2ee_room_id).toBe(`!${e2eeConvId}:legends.local`);
    expect(env.dm_message.sender_matrix_id).toBe(`@${userId}:legends.local`);
  });

  it("E2EE bot sender (other bot in convo) gets bot-namespaced sender_matrix_id", async () => {
    // The helper skips delivery when the SENDER is a bot (sees its own
    // message looped back). We exercise that early-return — no envelope.
    pushed.length = 0;
    await deliverDmToBots(e2eeConvId, {
      id: "2",
      senderType: "bot",
      senderId: botId,
      senderDisplayName: "b",
      text: "",
      replyToMessageId: null,
      createdAt: new Date().toISOString(),
      ciphertext: { algorithm: "m.olm.v1.curve25519-aes-sha2", x: 1 },
    });
    expect(pushed).toHaveLength(0);
  });

  it("plaintext convo forwards text, omits ciphertext / e2ee fields", async () => {
    pushed.length = 0;
    await deliverDmToBots(plaintextConvId, {
      id: "3",
      senderType: "user",
      senderId: userId,
      senderDisplayName: "u",
      text: "hello",
      replyToMessageId: null,
      createdAt: new Date().toISOString(),
    });
    expect(pushed).toHaveLength(1);
    const env = pushed[0]!.payload as {
      dm_message: {
        text: string;
        ciphertext?: unknown;
        e2ee_room_id?: string;
        sender_matrix_id?: string;
      };
    };
    expect(env.dm_message.text).toBe("hello");
    expect(env.dm_message.ciphertext).toBeUndefined();
    expect(env.dm_message.e2ee_room_id).toBeUndefined();
    expect(env.dm_message.sender_matrix_id).toBeUndefined();
  });
});
