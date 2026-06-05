"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { Search, Plus } from "lucide-react";
import { WS_EVENTS } from "@legends/shared";
import { cn } from "@/lib/cn";
import { ChatListItem, type ChatItem } from "@/components/ChatListItem";
import { NewChatModal } from "@/components/NewChatModal";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ChatListFilter = "all" | "topics" | "dms" | "bots";

export interface ChatListPaneProps {
  /** Server-rendered initial snapshot — kept fresh client-side via sockets. */
  initialItems: ChatItem[];
  /** Authenticated user id; reserved for future DM unread bookkeeping. */
  currentUserId: string;
  /**
   * Current route (e.g. `/t/general` or `/dm/abc`). When provided, the
   * matching row is highlighted. The pane itself never *navigates*; clicks
   * follow the `<Link>` `href` baked into each item.
   */
  activeHref?: string;
}

// ---------------------------------------------------------------------------
// Socket payloads (defensive typing — apps/ws is the source of truth)
// ---------------------------------------------------------------------------

type SidebarUpdate = {
  topicId: string;
  preview: string;
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
// Small inline debounce hook — avoids pulling in lodash for one call site
// ---------------------------------------------------------------------------

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Sort + filter helpers
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

function matchesFilter(item: ChatItem, filter: ChatListFilter): boolean {
  switch (filter) {
    case "topics":
      return item.kind === "topic";
    case "dms":
      return item.kind === "dm-user";
    case "bots":
      return item.kind === "dm-bot";
    case "all":
    default:
      return true;
  }
}

function parseFilter(raw: string | null): ChatListFilter {
  if (raw === "topics" || raw === "dms" || raw === "bots" || raw === "all") return raw;
  return "all";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const FILTERS: { key: ChatListFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "topics", label: "Topics" },
  { key: "dms", label: "DMs" },
  { key: "bots", label: "Bots" },
];

export function ChatListPane({ initialItems, currentUserId, activeHref }: ChatListPaneProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [items, setItems] = useState<ChatItem[]>(initialItems);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 150);
  const [newChatOpen, setNewChatOpen] = useState(false);

  // Keep `items` in sync if the server-rendered initial snapshot changes
  // (e.g. navigation back to `/` after a fresh fetch). React's referential
  // equality on the prop is enough — initialItems is rebuilt server-side.
  const initialRef = useRef(initialItems);
  useEffect(() => {
    if (initialRef.current !== initialItems) {
      initialRef.current = initialItems;
      setItems(initialItems);
    }
  }, [initialItems]);

  // ── Filter sync with `?filter=` ────────────────────────────────────────────
  const filter = parseFilter(searchParams?.get("filter") ?? null);
  const setFilter = useCallback(
    (next: ChatListFilter) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next === "all") params.delete("filter");
      else params.set("filter", next);
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, searchParams],
  );

  // ── Socket bumps ──────────────────────────────────────────────────────────
  // Mirror the connection options used by HomeLayout / useDmSocket so the ws
  // server's per-user room assignment still works (cookie auth).
  useEffect(() => {
    const socket: Socket = io(window.location.origin, {
      withCredentials: true,
      transports: ["polling", "websocket"],
    });

    // Topic last-message bump (mirrors HomeLayout).
    socket.on(WS_EVENTS.SIDEBAR_UPDATE, (u: SidebarUpdate) => {
      setItems((prev) => {
        const idx = prev.findIndex((it) => it.kind === "topic" && it.id === u.topicId);
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
          unreadCount: cur.unreadCount + 1,
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
      const isOutgoing = u.senderType === "user" && u.senderId === currentUserId;
      let found = false;
      setItems((prev) => {
        const idx = prev.findIndex(
          (it) => (it.kind === "dm-user" || it.kind === "dm-bot") && it.id === u.conversationId,
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
    //   POST /api/dm/${id}/accept
    //   POST /api/dm/${id}/decline
    // v1: always request a refresh; the page owns the re-fetch.
    socket.on(WS_EVENTS.DM_CONVERSATION_UPDATED, () => {
      window.dispatchEvent(new CustomEvent("chatlist:refresh"));
    });

    return () => {
      socket.disconnect();
    };
  }, [currentUserId]);

  // ── Derived view ──────────────────────────────────────────────────────────
  const visible = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const filtered = items.filter((it) => {
      if (!matchesFilter(it, filter)) return false;
      if (q && !it.title.toLowerCase().includes(q)) return false;
      return true;
    });
    return filtered.slice().sort(compareChatItems);
  }, [items, filter, debouncedQuery]);

  const totalItems = items.length;
  const noResults = visible.length === 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search */}
      <div className="sticky top-0 z-10 bg-panel pb-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              className="w-full rounded-lg bg-panel2 pl-8 pr-3 py-2 text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-accent"
              aria-label="Search chats"
            />
          </div>
          <button
            type="button"
            onClick={() => setNewChatOpen(true)}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-panel2 text-muted transition hover:bg-accent hover:text-white"
            title="New chat"
            aria-label="New chat"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {/* Filter chips */}
        <div className="flex items-center gap-2 py-2">
          {FILTERS.map((f) => {
            const isActive = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-medium transition",
                  isActive
                    ? "bg-accent text-white"
                    : "bg-panel2 text-muted hover:text-text",
                )}
                aria-pressed={isActive}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* New-chat modal */}
      <NewChatModal open={newChatOpen} onClose={() => setNewChatOpen(false)} />

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {noResults ? (
          <div className="px-3 py-8 text-center text-xs text-muted">
            {totalItems === 0 ? "No chats yet" : "No chats match"}
          </div>
        ) : (
          <div className="space-y-0.5">
            {visible.map((it) => (
              <ChatListItem
                key={`${it.kind}:${it.id}`}
                item={it}
                active={!!activeHref && activeHref === it.href}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
