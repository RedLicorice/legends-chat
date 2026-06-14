import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { dmConversations, dmParticipants, users, bots } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { listChatItems } from "@/lib/chat-list";

export const dynamic = "force-dynamic";

// GET /api/dm/[id]
// Returns the payload needed to render <ChatPane mode={kind:"dm"}> via DMThreadView
// client. Mirrors the SSR gates the previous page.tsx performed:
//   - 401 if unauthenticated (defence-in-depth on top of middleware)
//   - 404 if the conversation does not exist
//   - 404 if the current user is not a participant
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [conv] = await db
    .select({
      id: dmConversations.id,
      isE2ee: dmConversations.isE2ee,
      e2eeRoomId: dmConversations.e2eeRoomId,
      state: dmConversations.state,
      initiatorType: dmConversations.initiatorType,
      initiatorId: dmConversations.initiatorId,
    })
    .from(dmConversations)
    .where(eq(dmConversations.id, id))
    .limit(1);
  if (!conv) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parts = await db
    .select({ principalType: dmParticipants.principalType, principalId: dmParticipants.principalId })
    .from(dmParticipants)
    .where(eq(dmParticipants.conversationId, id));
  const isMember = parts.some(
    (p) => p.principalType === "user" && p.principalId === user.id,
  );
  if (!isMember) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Resolve peer (other participant).
  const peerPart = parts.find(
    (p) => !(p.principalType === "user" && p.principalId === user.id),
  );
  let peer: {
    type: "user" | "bot";
    id: string;
    displayName: string;
    avatarUrl: string | null;
  } | null = null;
  if (peerPart?.principalType === "user") {
    const [u] = await db
      .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, peerPart.principalId))
      .limit(1);
    if (u) peer = { type: "user", id: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl };
  } else if (peerPart?.principalType === "bot") {
    const [b] = await db
      .select({ id: bots.id, name: bots.name, avatarUrl: bots.avatarUrl })
      .from(bots)
      .where(eq(bots.id, peerPart.principalId))
      .limit(1);
    if (b) peer = { type: "bot", id: b.id, displayName: b.name, avatarUrl: b.avatarUrl };
  }

  const chatItems = await listChatItems(user.id, user.role, user.permissions);

  return NextResponse.json({
    user: {
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
      permissions: [...user.permissions],
      presenceOptOut: user.presenceOptOut,
    },
    chatItems,
    conversation: {
      id: conv.id,
      isE2ee: conv.isE2ee,
      e2eeRoomId: conv.e2eeRoomId,
      state: conv.state,
      // `incoming` = current user is the recipient of the pending request
      // (i.e. NOT the initiator). Sender sees a "waiting for them" message;
      // recipient sees Accept/Decline/Block.
      incoming: !(conv.initiatorType === "user" && conv.initiatorId === user.id),
      peer,
    },
  });
}
