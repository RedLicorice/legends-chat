import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { dmBlocks, dmConversations } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant, recipientUserIds } from "@/lib/dm";
import { markDmRequestNotificationsRead, publishDmConversationUpdated } from "@/lib/dm-requests";

/**
 * Decline a pending DM request. Recipient-only — the initiator can't "decline"
 * their own outgoing request (they'd just leave it pending; a separate
 * cancel path is out of scope).
 *
 * Decline = soft block: writes a `dm_blocks` row from the recipient to the
 * initiator and flips the conversation to `state='blocked'`. This is the same
 * shape as the existing `/api/dm/[id]/block` endpoint, but we keep them as
 * distinct routes because the UI semantics differ — decline is a one-click
 * action on an unaccepted request, block is a moderation action on an open
 * thread — and the audit story is clearer if they don't share a path.
 *
 * Also clears the `dm_request` notification badge for this conversation.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await assertParticipant(id, user.id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const [conv] = await db.select().from(dmConversations).where(eq(dmConversations.id, id)).limit(1);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Only the recipient can decline. Initiator hitting decline on their own
  // pending request is a 403 — that case has no sensible UX and is almost
  // certainly a client bug worth surfacing.
  if (conv.initiatorId === user.id) {
    return NextResponse.json({ error: "cannot decline own request" }, { status: 403 });
  }

  // Block the initiator (and any other user peers — there should only be one
  // in 1:1 DMs, but the helper handles it generically).
  const peers = await recipientUserIds(id, user.id);
  for (const p of peers) {
    await db
      .insert(dmBlocks)
      .values({ blockerUserId: user.id, blockedUserId: p })
      .onConflictDoNothing();
  }
  await db.update(dmConversations).set({ state: "blocked" }).where(eq(dmConversations.id, id));
  await markDmRequestNotificationsRead({ recipientUserId: user.id, conversationId: id });
  // Notify both sides so the initiator's sidebar drops/updates the row and the
  // recipient's other sessions stay in sync. `peers` was computed above for
  // the dm_blocks insert; reuse it as the fan-out list.
  await publishDmConversationUpdated({
    conversationId: id,
    state: "blocked",
    userIds: [user.id, ...peers],
  });

  return NextResponse.json({ ok: true });
}
