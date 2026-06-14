// POST /api/dm/[id]/decline — delete + notify behavior.
//
// Refactor: decline used to be a soft-block (insert dm_blocks row, flip state
// to 'blocked'). The new contract:
//   - delete the conversation row (cascade dm_participants + dm_messages)
//   - emit a `dm_request_declined` notification for the initiator
//   - publish DM_CONVERSATION_UPDATED with state="declined" to both peers
//   - do NOT touch dm_blocks (block is a separate explicit endpoint)
//
// This test seeds a pending convo with one message, calls decline as the
// recipient, and asserts every leg of the contract.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql, eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

// Capture Redis publishes so we can assert the WS event without spinning up a
// real Redis. Pattern mirrors api-bot-send-dm-message.test.ts.
const published: { channel: string; payload: unknown }[] = [];
vi.mock("@/lib/redis", () => ({
  redis: {
    publish: async (channel: string, val: string) => {
      published.push({ channel, payload: JSON.parse(val) });
      return 1;
    },
  },
}));

// We need to control which user the handler sees. Cookie auth → mock
// getCurrentUser, identical to other api-dm tests.
const currentUser = { id: "" } as { id: string };
vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => Promise.resolve({ id: currentUser.id, isAnon: false }),
}));

const { POST } = await import("@/app/api/dm/[id]/decline/route");
const { db } = await import("@/lib/db");
const {
  dmConversations,
  dmParticipants,
  dmMessages,
  dmBlocks,
  notifications,
  encryptionKeys,
} = await import("@legends/db/schema");

async function makeKey(): Promise<string> {
  const id = randomUUID();
  await db.insert(encryptionKeys).values({
    id,
    purpose: "messages",
    wrappedKey: new Uint8Array([0, 1]),
  });
  return id;
}

async function seedPendingConv(opts: {
  initiatorName: string;
  recipientName: string;
  withMessage?: boolean;
}): Promise<{ convId: string; initiatorId: string; recipientId: string }> {
  const initiatorId = randomUUID();
  const recipientId = randomUUID();
  await db.execute(
    sql`INSERT INTO users (id, display_name) VALUES (${initiatorId}, ${opts.initiatorName}), (${recipientId}, ${opts.recipientName}) ON CONFLICT DO NOTHING`,
  );
  const dmKey = `u:${initiatorId}|u:${recipientId}|${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const [conv] = await db
    .insert(dmConversations)
    .values({
      dmKey,
      isE2ee: false,
      state: "pending",
      initiatorType: "user",
      initiatorId,
    })
    .returning({ id: dmConversations.id });
  const convId = conv!.id;
  await db.insert(dmParticipants).values([
    { conversationId: convId, principalType: "user", principalId: initiatorId },
    { conversationId: convId, principalType: "user", principalId: recipientId },
  ]);
  if (opts.withMessage) {
    const keyId = await makeKey();
    await db.insert(dmMessages).values({
      conversationId: convId,
      senderType: "user",
      senderId: initiatorId,
      contentCiphertext: new Uint8Array([1, 2, 3]),
      contentNonce: new Uint8Array([4, 5, 6]),
      keyId,
    });
  }
  return { convId, initiatorId, recipientId };
}

// Cast to NextRequest — the route only reads from { params }, never the
// request object. Mirrors the same shortcut other api-dm tests take.
function postReq(convId: string): NextRequest {
  return new Request(`http://t/api/dm/${convId}/decline`, { method: "POST" }) as unknown as NextRequest;
}

beforeEach(() => {
  published.length = 0;
});

describe("POST /api/dm/[id]/decline", () => {
  it("deletes the conversation, cascades messages + participants, notifies initiator", async () => {
    const { convId, initiatorId, recipientId } = await seedPendingConv({
      initiatorName: "declined-init",
      recipientName: "declined-recv",
      withMessage: true,
    });

    // Decline as the recipient.
    currentUser.id = recipientId;
    const res = await POST(postReq(convId), {
      params: Promise.resolve({ id: convId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Conversation row is gone.
    const remainingConv = await db
      .select({ id: dmConversations.id })
      .from(dmConversations)
      .where(eq(dmConversations.id, convId));
    expect(remainingConv).toHaveLength(0);

    // Participants cascaded.
    const remainingParts = await db
      .select({ pid: dmParticipants.principalId })
      .from(dmParticipants)
      .where(eq(dmParticipants.conversationId, convId));
    expect(remainingParts).toHaveLength(0);

    // Messages cascaded.
    const remainingMsgs = await db
      .select({ id: dmMessages.id })
      .from(dmMessages)
      .where(eq(dmMessages.conversationId, convId));
    expect(remainingMsgs).toHaveLength(0);

    // No dm_blocks row was created (regression vs the old soft-block).
    const blocks = await db
      .select({ b: dmBlocks.blockerUserId })
      .from(dmBlocks)
      .where(
        and(
          eq(dmBlocks.blockerUserId, recipientId),
          eq(dmBlocks.blockedUserId, initiatorId),
        ),
      );
    expect(blocks).toHaveLength(0);

    // Initiator got a `dm_request_declined` notification.
    const notifs = await db
      .select({ type: notifications.type, payload: notifications.payload })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, initiatorId),
          eq(notifications.type, "dm_request_declined"),
        ),
      );
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    const payload = notifs[0]!.payload as {
      conversation_id: string;
      recipient_display_name: string;
    };
    expect(payload.conversation_id).toBe(convId);
    expect(payload.recipient_display_name).toBe("declined-recv");

    // WS event published with state="declined" and both peers in the fan-out
    // list. We don't pin the channel constant here — only that
    // dm:conversation:updated semantics fired with the synthetic state.
    const dmUpdates = published.filter(
      (p) =>
        (p.payload as { state?: string } | null)?.state === "declined" &&
        (p.payload as { conversationId?: string } | null)?.conversationId === convId,
    );
    expect(dmUpdates).toHaveLength(1);
    const fan = (dmUpdates[0]!.payload as { userIds: string[] }).userIds;
    expect(fan).toContain(initiatorId);
    expect(fan).toContain(recipientId);
  });

  it("403 when initiator tries to decline their own request", async () => {
    const { convId, initiatorId } = await seedPendingConv({
      initiatorName: "self-decline-init",
      recipientName: "self-decline-recv",
    });
    currentUser.id = initiatorId;
    const res = await POST(postReq(convId), {
      params: Promise.resolve({ id: convId }),
    });
    expect(res.status).toBe(403);
  });
});
