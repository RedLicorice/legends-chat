"use client";

import { useMemo } from "react";
import { ChatPane } from "@/components/ChatPane";
import { PWASplash } from "@/components/PWASplash";
import { useChatShell } from "@/components/ChatShell";
import { useDm } from "@/lib/hooks/use-dm";
import { createDmChatSource } from "@/lib/chat-source/dm";
import { createOlmChatCrypto } from "@/lib/chat-crypto";

interface Props {
  id: string;
}

/**
 * `/dm/<id>` right pane. ChatShell upstream owns the sidebar + chat list;
 * this component only owns the ChatPane and its source/crypto.
 */
export function DmRightPane({ id }: Props) {
  const { data, status } = useDm(id);
  const { openSidebar, expandDesktopSidebar, desktopCollapsed, compactMode } =
    useChatShell();
  const showExpandSidebar = desktopCollapsed && compactMode === "minimal";

  const peer = data?.conversation.peer ?? null;
  const peerId = peer?.type === "user" ? peer.id : null;
  const roomKey = data?.conversation.e2eeRoomId ?? null;
  const isE2ee = !!data?.conversation.isE2ee;
  const conversationId = data?.conversation.id ?? null;
  const currentUserId = data?.user.id ?? null;

  const source = useMemo(() => {
    if (!conversationId || !currentUserId) return null;
    return createDmChatSource({
      conversationId,
      currentUserId,
      peer:
        peer && peer.type === "user"
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
    if (!isE2ee || !roomKey || !peerId) return null;
    return createOlmChatCrypto(roomKey, peerId);
  }, [isE2ee, roomKey, peerId]);

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
