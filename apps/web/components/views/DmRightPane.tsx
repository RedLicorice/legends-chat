"use client";

import { useMemo } from "react";
import { ChatPane } from "@/components/ChatPane";
import { PWASplash } from "@/components/PWASplash";
import { useAppShell } from "@/components/AppShell";
import { useDm } from "@/lib/hooks/use-dm";
import { createDmChatSource } from "@/lib/chat-source/dm";
import { createOlmChatCrypto } from "@/lib/chat-crypto";
import { toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";

interface Props {
  id: string;
}

/**
 * `/c/<id>` right pane. AppShell upstream owns the sidebar + chat list;
 * this component only owns the ChatPane and its source/crypto.
 */
export function DmRightPane({ id }: Props) {
  const { data, status } = useDm(id);
  const { openSidebar, expandDesktopSidebar, desktopCollapsed, compactMode } =
    useAppShell();
  const showExpandSidebar = desktopCollapsed && compactMode === "minimal";

  const peer = data?.conversation.peer ?? null;
  // Bug 20: bot peers also need a chatCrypto in E2EE DMs. Build the
  // Matrix-shaped id at this boundary so the crypto layer doesn't have to
  // know about Legends' user/bot distinction. `@bot.<uuid>:legends.local`
  // vs `@<uuid>:legends.local` keeps targeting unambiguous on the wire.
  const peerMatrixId = peer
    ? peer.type === "bot"
      ? toMatrixBotId(peer.id)
      : toMatrixUserId(peer.id)
    : null;
  const roomKey = data?.conversation.e2eeRoomId ?? null;
  const isE2ee = !!data?.conversation.isE2ee;
  const conversationId = data?.conversation.id ?? null;
  const currentUserId = data?.user.id ?? null;

  const source = useMemo(() => {
    if (!conversationId || !currentUserId) return null;
    // PeerLookup only consumes displayName/avatarUrl for rendering — bot
    // and user peers both have those, so don't drop bots here (was Bug 20).
    return createDmChatSource({
      conversationId,
      currentUserId,
      peer: peer
        ? {
            id: peer.id,
            displayName: peer.displayName,
            avatarUrl: peer.avatarUrl,
          }
        : null,
      roomKey,
    });
  }, [conversationId, currentUserId, peer, roomKey]);

  const chatCrypto = useMemo(() => {
    if (!isE2ee || !roomKey || !peerMatrixId) return null;
    return createOlmChatCrypto(roomKey, peerMatrixId);
  }, [isE2ee, roomKey, peerMatrixId]);

  if ((!data && status === "loading") || !id) {
    return <PWASplash />;
  }

  if (status === "notFound") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-fg">
        <h1 className="text-xl font-semibold">Conversation not found</h1>
        <p className="text-sm text-muted">
          This DM doesn&apos;t exist or you don&apos;t have access to it.
        </p>
        <a
          href="/"
          className="mt-2 rounded-md bg-panel2 px-3 py-1.5 text-sm hover:bg-panel"
        >
          Go home
        </a>
      </div>
    );
  }

  if (status === "error" || !data || !source) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-fg">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted">
          Failed to load this conversation. Try refreshing.
        </p>
      </div>
    );
  }

  return (
    <ChatPane
      user={{
        id: data.user.id,
        displayName: data.user.displayName,
        avatarUrl: data.user.avatarUrl,
        role: data.user.role,
        presenceOptOut: data.user.presenceOptOut,
        permissions: data.user.permissions,
      }}
      mode={{
        kind: "dm",
        conversation: {
          id: data.conversation.id,
          isE2ee: data.conversation.isE2ee,
          e2eeRoomId: data.conversation.e2eeRoomId,
          state: data.conversation.state,
          incoming: data.conversation.incoming,
          peer: data.conversation.peer,
        },
      }}
      source={source}
      chatCrypto={chatCrypto}
      onMenuOpen={openSidebar}
      showExpandSidebar={showExpandSidebar}
      onExpandSidebar={expandDesktopSidebar}
    />
  );
}
