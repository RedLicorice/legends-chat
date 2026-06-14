import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { dmConversations, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant, recipientUserIds } from "@/lib/dm";
import {
  emitDmRequestDeclinedNotification,
  markDmRequestNotificationsRead,
  publishDmConversationUpdated,
} from "@/lib/dm-requests";

/**
 * Decline a pending DM request. Recipient-only — the initiator can't "decline"
 * their own outgoing request (they'd just leave it pending; a separate
 * cancel path is out of scope).
 *
 * Decline = delete. The conversation row is dropped (cascade across
 * `dm_participants` and `dm_messages` via FK), and a `dm_request_declined`
 * notification is created for the initiator so they learn what happened.
 * The decline path is no longer a soft-block — that's what the separate
 * `/api/dm/[id]/block` endpoint is for; this makes the two intents
 * independent and avoids surprising the recipient with an implicit block.
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

  // Compute the peer fan-out list BEFORE deleting the conversation — once the
  // cascade fires, dm_participants is empty and recipientUserIds would return
  // []. Also resolve the recipient (this user's) display name for the inline
  // notification payload; the conversation will not exist by the time the
  // initiator's client renders the badge, so we can't join from there.
  const peers = await recipientUserIds(id, user.id);
  const [me] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const recipientDisplayName = me?.displayName ?? "Someone";

  // Clear any open badge before we delete, so the cleanup query has a stable
  // conversation_id to match on. (Strictly the cascade only touches dm_*
  // tables, not notifications, but flush first for symmetry with accept.)
  await markDmRequestNotificationsRead({ recipientUserId: user.id, conversationId: id });

  // Notify the initiator(s) of the decline so they get a bell update. The
  // conversation row is about to vanish, so inline the recipient name —
  // the receiver-side lookup would 404. We only fan to user-typed peers (bot
  // peers don't have a notifications bell, and decline-on-bot DMs is a
  // future-bug path we don't exercise today; bot DMs auto-accept).
  for (const initiatorId of peers) {
    await emitDmRequestDeclinedNotification({
      conversationId: id,
      initiatorUserId: initiatorId,
      recipientUserId: user.id,
      recipientDisplayName,
    });
  }

  // Drop the conversation. `dm_participants` and `dm_messages` both declare
  // `onDelete: 'cascade'`, so this single DELETE removes the whole graph.
  await db.delete(dmConversations).where(eq(dmConversations.id, id));

  // Tell every participant's other sessions to drop the sidebar row. State
  // `"declined"` is synthetic — there is no row to re-fetch, so the WS
  // handler must remove rather than refresh.
  await publishDmConversationUpdated({
    conversationId: id,
    state: "declined",
    userIds: [user.id, ...peers],
  });

  return NextResponse.json({ ok: true });
}
