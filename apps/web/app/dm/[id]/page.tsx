import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { dmConversations, dmParticipants, users, bots } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { listChatItems } from "@/lib/chat-list";
import { ChatLayout } from "@/components/ChatLayout";
import { DmThreadPane, type DmThreadConversation } from "@/components/DmThreadPane";

export const dynamic = "force-dynamic";

export default async function DmThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Confirm membership + load the conversation row.
  const [conv] = await db
    .select({
      id: dmConversations.id,
      isE2ee: dmConversations.isE2ee,
      e2eeRoomId: dmConversations.e2eeRoomId,
      state: dmConversations.state,
    })
    .from(dmConversations)
    .where(eq(dmConversations.id, id))
    .limit(1);
  if (!conv) notFound();

  const parts = await db
    .select({ principalType: dmParticipants.principalType, principalId: dmParticipants.principalId })
    .from(dmParticipants)
    .where(eq(dmParticipants.conversationId, id));
  const isMember = parts.some(
    (p) => p.principalType === "user" && p.principalId === user.id,
  );
  if (!isMember) notFound();

  // Resolve peer (other participant). Bots are not members so we look for any
  // non-(self user) participant row.
  const peerPart = parts.find(
    (p) => !(p.principalType === "user" && p.principalId === user.id),
  );
  let peer: DmThreadConversation["peer"] = null;
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

  const conversation: DmThreadConversation = {
    id: conv.id,
    isE2ee: conv.isE2ee,
    e2eeRoomId: conv.e2eeRoomId,
    peer,
  };

  const chatItems = await listChatItems(user.id, user.role, user.permissions);

  return (
    <ChatLayout
      user={{
        id: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        role: user.role,
        permissions: [...user.permissions],
        presenceOptOut: user.presenceOptOut,
      }}
      chatItems={chatItems}
      activeHref={`/dm/${id}`}
    >
      <DmThreadPane
        conversationId={id}
        currentUserId={user.id}
        conversation={conversation}
      />
    </ChatLayout>
  );
}
