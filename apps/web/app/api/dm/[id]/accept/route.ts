import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { dmConversations } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant, listConversations, recipientUserIds } from "@/lib/dm";
import { markDmRequestNotificationsRead, publishDmConversationUpdated } from "@/lib/dm-requests";

/**
 * Accept a pending DM request. Only the recipient (non-initiator) may accept;
 * an initiator hitting their own request is a no-op (returns the conversation
 * unchanged) rather than 403 so the client can be loose about who sent it.
 *
 * Side effects beyond the state flip:
 *  - mark any unread `dm_request` notifications for this conversation as read,
 *    so the bell badge drops without a separate "mark read" round-trip.
 *
 * Returns the recipient's conversation view (peer, isE2ee, e2eeRoomId, etc.)
 * so the frontend can drop the row straight into its sidebar list without
 * re-fetching `/api/dm`.
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

  // Only the recipient (non-initiator) can accept. Initiator hitting accept on
  // their own pending request is a no-op (returns the current view) — that
  // matches the old behaviour and avoids breaking any client that retries.
  if (conv.state === "pending" && conv.initiatorId !== user.id) {
    await db.update(dmConversations).set({ state: "accepted" }).where(eq(dmConversations.id, id));
    await markDmRequestNotificationsRead({ recipientUserId: user.id, conversationId: id });
    // Fan out a sidebar-refresh signal so the initiator's open session sees
    // the state flip without polling. We include the recipient too so any
    // second session for this user (e.g. another tab) syncs as well.
    const peers = await recipientUserIds(id, user.id);
    await publishDmConversationUpdated({
      conversationId: id,
      state: "accepted",
      userIds: [user.id, ...peers],
    });
  }

  // Re-derive the recipient's view so the client can render without a second
  // round-trip. `listConversations` already builds the peer record, e2eeRoomId,
  // and `incoming` flag — cheaper than reproducing that join shape inline.
  const all = await listConversations(user.id);
  const view = all.find((c) => c.id === id) ?? null;
  return NextResponse.json({ ok: true, conversation: view });
}
