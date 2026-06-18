"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { ChatListItem, type ChatItem } from "@/components/ChatListItem";
import { NewChatModal } from "@/components/NewChatModal";
import { useChatListContext } from "@/contexts/ChatListContext";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ChatListFilter = "all" | "topics" | "dms" | "bots";

export interface ChatListPaneProps {
  /**
   * Current route (e.g. `/t/general` or `/c/abc`). When provided, the
   * matching row is highlighted. The pane itself never *navigates*; clicks
   * follow the `<Link>` `href` baked into each item.
   */
  activeHref?: string;
}

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

export function ChatListPane({ activeHref }: ChatListPaneProps) {
  const searchParams = useSearchParams();

  // Items + socket live in the layout-level provider so they survive
  // navigation to /admin and /settings. This component is now purely
  // presentational over context state.
  const { items } = useChatListContext();

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 150);
  const [newChatOpen, setNewChatOpen] = useState(false);

  // Filter is local view state — driven from the sidebar without navigating
  // the current route. Previously this was URL-anchored (router.push to
  // `/?filter=X`), but that triggered AppShell's pathname-change effect that
  // auto-closes the mobile sidebar — so tapping a filter chip on phones
  // closed the sidebar instead of filtering. Initial value still seeds from
  // ?filter= so deep-links work; later changes don't write back to the URL.
  const [filter, setFilter] = useState<ChatListFilter>(() =>
    parseFilter(searchParams?.get("filter") ?? null),
  );

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
      <div className="sticky top-0 z-10 border-b border-border bg-panel">
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

        {/* Filter chips. On mobile we use larger tap targets (≥36px / iOS
            HIG minimum); on md+ desktop we shrink to compact text-[11px]
            chips since pointer accuracy is far higher with a mouse. */}
        <div className="flex items-center gap-1.5 pt-1 pb-1 md:gap-1">
          {FILTERS.map((f) => {
            const isActive = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs font-medium transition",
                  "md:px-2 md:py-0.5 md:text-[11px]",
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
      <div className="flex-1 min-h-0 overflow-y-auto pt-2">
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
