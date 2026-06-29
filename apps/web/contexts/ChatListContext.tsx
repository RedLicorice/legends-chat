"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { WS_EVENTS } from "@legends/shared";
import { useMe, type MeShape, type MeStatus } from "@/lib/hooks/use-me";
import {
  useChatList,
  type ChatListPayload,
} from "@/lib/hooks/use-chat-list";
import type { ResourceStatus } from "@/lib/hooks/use-api-resource";
import type { ChatItem } from "@/components/ChatListItem";

// ---------------------------------------------------------------------------
// Socket payloads — defensive typing (apps/ws is the source of truth)
// ---------------------------------------------------------------------------

type SidebarUpdate = {
  topicId: string;
  preview: string;
  /** Null for bot-sourced messages; the sender's user id otherwise. We use
   *  this to skip bumping unreadCount when our own send echoes back. */
  senderId: string | null;
  senderName: string | null;
  at: string;
};

type DmNewIncoming = {
  id: string;
  conversationId: string;
  senderId: string;
  senderType: string;
  text: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Sort helper — mirrors ChatListPane so re-sorts after socket bumps stay
// identical to the initial server-rendered order.
// ---------------------------------------------------------------------------

function compareChatItems(a: ChatItem, b: ChatItem): number {
  if (a.lastAt && b.lastAt) {
    if (a.lastAt > b.lastAt) return -1;
    if (a.lastAt < b.lastAt) return 1;
  } else if (a.lastAt) {
    return -1;
  } else if (b.lastAt) {
    return 1;
  }
  return a.title.localeCompare(b.title);
}

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface ChatListContextValue {
  me: MeShape | null;
  meStatus: MeStatus;
  items: ChatItem[];
  setItems: React.Dispatch<React.SetStateAction<ChatItem[]>>;
  chatList: ChatListPayload | null;
  chatListStatus: ResourceStatus;
  ready: boolean;
  currentUserId: string;
}

const ChatListContext = createContext<ChatListContextValue | null>(null);

export function useChatListContext(): ChatListContextValue {
  const ctx = useContext(ChatListContext);
  if (!ctx) {
    throw new Error(
      "useChatListContext must be used inside <ChatListProvider>",
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ChatListProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { me, status: meStatus } = useMe();
  const { data: chatList, status: chatListStatus } = useChatList();

  const [items, setItems] = useState<ChatItem[]>(
    () => chatList?.chatItems ?? [],
  );

  // Keep `items` in sync if the underlying chatList payload reference changes
  // (e.g. router.refresh re-fetched a new snapshot). Same guard pattern that
  // used to live inside ChatListPane.
  const initialRef = useRef<ChatItem[] | null>(chatList?.chatItems ?? null);
  useEffect(() => {
    if (!chatList) return;
    if (initialRef.current !== chatList.chatItems) {
      initialRef.current = chatList.chatItems;
      setItems(chatList.chatItems);
    }
  }, [chatList]);

  // ChatListPane (or any other consumer) dispatches `chatlist:refresh` when it
  // needs the server snapshot rebuilt (e.g. an accept/decline arrived for a
  // conversation we don't yet have in the list). router.refresh() reruns the
  // server tree. Moved here from the former ChatShell so the listener survives navigation
  // away from chat routes.
  useEffect(() => {
    const onRefresh = () => router.refresh();
    window.addEventListener("chatlist:refresh", onRefresh);
    return () => window.removeEventListener("chatlist:refresh", onRefresh);
  }, [router]);

  // ── Socket bumps ──────────────────────────────────────────────────────────
  // Connect once `me` is known; survive across every route in the tab.
  // Mirror the connection options used by HomeLayout / useDmSocket so the ws
  // server's per-user room assignment still works (cookie auth).
  const currentUserId = me?.id ?? "";
  useEffect(() => {
    if (!me?.id) return;
    if (typeof window === "undefined") return;

    const socket: Socket = io(window.location.origin, {
      withCredentials: true,
      transports: ["polling", "websocket"],
    });

    // Debug handle for verification scripts. Cheap; harmless in prod.
    (window as unknown as { __chatListSocket?: Socket }).__chatListSocket =
      socket;

    // Topic last-message bump (mirrors HomeLayout).
    socket.on(WS_EVENTS.SIDEBAR_UPDATE, (u: SidebarUpdate) => {
      // Server fans out to every topic member including the sender. The row
      // should still bump (preview + lastAt + sort), but unread must NOT
      // increment on our own send.
      const isOutgoing = !!u.senderId && u.senderId === me.id;
      setItems((prev) => {
        const idx = prev.findIndex(
          (it) => it.kind === "topic" && it.id === u.topicId,
        );
        if (idx === -1) return prev;
        const next = prev.slice();
        const cur = next[idx]!;
        next[idx] = {
          ...cur,
          lastAt: u.at,
          // E2EE rows never render a server-side preview; keep `lastPreview`
          // null so the renderer falls back to the topic description. The ws
          // server already ships an empty string for these, but null-coerce
          // defensively in case an older payload arrives.
          lastPreview: cur.isE2ee ? null : u.preview,
          unreadCount: isOutgoing ? cur.unreadCount : cur.unreadCount + 1,
        };
        return next.sort(compareChatItems);
      });
    });

    // DM new message (matches the WS_EVENTS key emitted by apps/ws). If the
    // conversation isn't in our list yet (e.g. a request that was just
    // accepted from NotificationBell), we don't have enough info on the wire
    // to fully render the row — fire a refresh signal and let the page
    // re-fetch initialItems. The custom-event indirection keeps this
    // component decoupled from the server fetcher.
    socket.on(WS_EVENTS.DM_NEW, (u: DmNewIncoming) => {
      // ws fan-outs DM_MESSAGE_NEW to every participant, including the sender.
      // Bumping unreadCount on the sender's own outgoing send would falsely
      // mark their own thread unread — only count messages from the other side.
      const isOutgoing = u.senderType === "user" && u.senderId === me.id;
      let found = false;
      setItems((prev) => {
        const idx = prev.findIndex(
          (it) =>
            (it.kind === "dm-user" || it.kind === "dm-bot") &&
            it.id === u.conversationId,
        );
        if (idx === -1) return prev;
        found = true;
        const next = prev.slice();
        const cur = next[idx]!;
        next[idx] = {
          ...cur,
          lastAt: u.createdAt,
          // Plaintext rows ship `text`; E2EE rows render no preview at all
          // (the row keeps title + lastAt + lock + unread badge).
          lastPreview: cur.isE2ee ? null : u.text,
          unreadCount: isOutgoing ? cur.unreadCount : cur.unreadCount + 1,
        };
        return next.sort(compareChatItems);
      });
      if (!found) {
        window.dispatchEvent(new CustomEvent("chatlist:refresh"));
      }
    });

    // Conversation lifecycle (accept/decline). Backend emits this from:
    //   POST /api/dm/${id}/accept    → state="accepted"
    //   POST /api/dm/${id}/decline   → state="declined" (synthetic: the row
    //                                  was deleted, do NOT refresh — refresh
    //                                  would race with the server snapshot
    //                                  and still drop the row, but skipping
    //                                  avoids the flash and a wasted GET).
    // For accept (and any future state we don't have a local handler for),
    // dispatch the existing refresh signal so the page owner re-fetches.
    socket.on(
      WS_EVENTS.DM_CONVERSATION_UPDATED,
      (u: { conversationId: string; state: string }) => {
        // "declined" (recipient rejected a pending request) and "deleted"
        // (Delete Conversation) are both synthetic row-removals — drop the
        // sidebar row and notify any open ChatPane so it can navigate away.
        // They differ only in the client event (declined shows a toast; deleted
        // is silent).
        if (u?.state === "declined" || u?.state === "deleted") {
          setItems((prev) =>
            prev.filter(
              (it) =>
                !(
                  (it.kind === "dm-user" || it.kind === "dm-bot") &&
                  it.id === u.conversationId
                ),
            ),
          );
          window.dispatchEvent(
            new CustomEvent(
              u.state === "deleted" ? "dm:conversation:deleted" : "dm:conversation:declined",
              { detail: { conversationId: u.conversationId } },
            ),
          );
          return;
        }
        window.dispatchEvent(new CustomEvent("chatlist:refresh"));
      },
    );

    return () => {
      const w = window as unknown as { __chatListSocket?: Socket };
      if (w.__chatListSocket === socket) {
        delete w.__chatListSocket;
      }
      socket.disconnect();
    };
    // Intentionally only re-run when the authenticated user id changes — not
    // on every render. setItems is a stable React setter, no need to list it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  const ready = meStatus === "authenticated" && chatListStatus === "ready";

  const value: ChatListContextValue = {
    me,
    meStatus,
    items,
    setItems,
    chatList,
    chatListStatus,
    ready,
    currentUserId,
  };

  return (
    <ChatListContext.Provider value={value}>
      {children}
    </ChatListContext.Provider>
  );
}
