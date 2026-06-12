// topic_bots E2EE gate + Megolm rotation (Task 16).
//
// E2EE topics now accept bots whose e2ee_state is 'ready' and reject any
// non-ready bot with BOT_E2EE_REQUIRED. On both add and remove, the route
// fans out one user_device_change_log row per topic member so their next
// /api/crypto/sync surfaces a device_lists.changed entry and OlmMachine
// rotates the outbound Megolm session targeting the (now-changed) device set.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

const FAKE_ADMIN_ID = randomUUID();
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({
    id: FAKE_ADMIN_ID,
    isAnon: false,
    displayName: "a",
    avatarUrl: null,
    permissions: new Set(["bots.manage", "BOTS_MANAGE"]),
  }),
}));

const { db } = await import("@/lib/db");
const { bots, topics, topicBots, topicMembers, userDeviceChangeLog } = await import(
  "@legends/db/schema"
);
const { POST: ADD } = await import("@/app/api/admin/topics/[id]/bots/route");
const { DELETE: REMOVE } = await import("@/app/api/admin/topics/[id]/bots/[botId]/route");

async function addBot(topicId: string, botId: string): Promise<Response> {
  return ADD(
    new Request(`http://t/admin/topics/${topicId}/bots`, {
      method: "POST",
      body: JSON.stringify({ botId }),
    }),
    { params: Promise.resolve({ id: topicId }) },
  );
}
async function removeBot(topicId: string, botId: string): Promise<Response> {
  return REMOVE(
    new Request(`http://t/admin/topics/${topicId}/bots/${botId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: topicId, botId }) },
  );
}

let e2eeTopicId: string;
let memberUserId: string;
let readyBotId: string;
let pendingBotId: string;

describe("topic_bots E2EE gate + rotation", () => {
  beforeAll(async () => {
    memberUserId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${FAKE_ADMIN_ID}, 'adm'), (${memberUserId}, 'mem') ON CONFLICT DO NOTHING`,
    );
    const slug = `tbe-${randomUUID().slice(0, 8)}`;
    const [t] = await db
      .insert(topics)
      .values({ slug, title: "tbe", isE2ee: true, historyVisibleToNewMembers: false })
      .returning({ id: topics.id });
    e2eeTopicId = t!.id;
    await db
      .update(topics)
      .set({ e2eeRoomId: `!${e2eeTopicId}:legends.local` })
      .where(sql`${topics.id} = ${e2eeTopicId}`);
    await db.insert(topicMembers).values({ topicId: e2eeTopicId, userId: memberUserId });

    const [b1] = await db
      .insert(bots)
      .values({
        name: `tbe-ready-${randomUUID().slice(0, 8)}`,
        ownerUserId: FAKE_ADMIN_ID,
        isActive: true,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        e2eeState: "ready",
        e2eeDeviceId: "X",
      })
      .returning({ id: bots.id });
    readyBotId = b1!.id;

    const [b2] = await db
      .insert(bots)
      .values({
        name: `tbe-pending-${randomUUID().slice(0, 8)}`,
        ownerUserId: FAKE_ADMIN_ID,
        isActive: true,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        e2eeState: "pending",
      })
      .returning({ id: bots.id });
    pendingBotId = b2!.id;
  });

  it("add ready bot to E2EE topic succeeds + logs device change for members", async () => {
    const res = await addBot(e2eeTopicId, readyBotId);
    expect(res.status).toBe(200);
    const tbs = await db
      .select()
      .from(topicBots)
      .where(sql`${topicBots.topicId} = ${e2eeTopicId} AND ${topicBots.botId} = ${readyBotId}`);
    expect(tbs).toHaveLength(1);
    const changes = await db
      .select()
      .from(userDeviceChangeLog)
      .where(sql`${userDeviceChangeLog.userId} = ${memberUserId}`);
    expect(changes.length).toBeGreaterThanOrEqual(1);
  });

  it("add non-ready bot to E2EE topic returns 400 bot_e2ee_required", async () => {
    const res = await addBot(e2eeTopicId, pendingBotId);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bot_e2ee_required");
  });

  it("removing a bot logs another device-change for members", async () => {
    const beforeCount = (
      await db
        .select()
        .from(userDeviceChangeLog)
        .where(sql`${userDeviceChangeLog.userId} = ${memberUserId}`)
    ).length;
    const res = await removeBot(e2eeTopicId, readyBotId);
    expect(res.status).toBe(200);
    const afterCount = (
      await db
        .select()
        .from(userDeviceChangeLog)
        .where(sql`${userDeviceChangeLog.userId} = ${memberUserId}`)
    ).length;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });
});
