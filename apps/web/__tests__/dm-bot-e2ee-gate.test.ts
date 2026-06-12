// dm.ts bot E2EE state-machine gate.
//
// Task 14: openConversation must now branch on bots.e2eeState instead of a
// blanket reject. 'disabled' → BOT_E2EE_DISABLED, 'pending' → BOT_E2EE_NOT_READY,
// 'ready' → succeeds (and returns an E2EE convo).
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { openConversation } from "@/lib/dm";
import { db } from "@/lib/db";
import { bots } from "@legends/db/schema";
import { BOT_E2EE_ERROR_CODES } from "@legends/shared";

async function makeBot(state: "disabled" | "pending" | "ready"): Promise<{ botId: string; userId: string }> {
  const ownerId = randomUUID();
  const userId = randomUUID();
  await db.execute(
    sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'gO'), (${userId}, 'gU') ON CONFLICT DO NOTHING`,
  );
  const [b] = await db
    .insert(bots)
    .values({
      name: `gate-${state}-${randomUUID()}`,
      ownerUserId: ownerId,
      dmEnabled: true,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      e2eeState: state,
    })
    .returning({ id: bots.id });
  return { botId: b!.id, userId };
}

describe("dm.ts bot E2EE state-machine gate", () => {
  it("disabled → throws BOT_E2EE_DISABLED", async () => {
    const { botId, userId } = await makeBot("disabled");
    await expect(
      openConversation(userId, { type: "bot", id: botId }, { e2ee: true }),
    ).rejects.toMatchObject({ code: BOT_E2EE_ERROR_CODES.BOT_E2EE_DISABLED });
  });

  it("pending → throws BOT_E2EE_NOT_READY", async () => {
    const { botId, userId } = await makeBot("pending");
    await expect(
      openConversation(userId, { type: "bot", id: botId }, { e2ee: true }),
    ).rejects.toMatchObject({ code: BOT_E2EE_ERROR_CODES.BOT_E2EE_NOT_READY });
  });

  it("ready → succeeds + returns isE2ee=true convo", async () => {
    const { botId, userId } = await makeBot("ready");
    const out = await openConversation(userId, { type: "bot", id: botId }, { e2ee: true });
    expect(out.id).toBeDefined();
    expect(out.e2eeRoomId).toMatch(/^!.+:legends\.local$/);
  });
});
