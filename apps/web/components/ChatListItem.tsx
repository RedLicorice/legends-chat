"use client";

import Link from "next/link";
import { Hash, Bot as BotIcon, Lock } from "lucide-react";
import { cn } from "@/lib/cn";

/** Discriminator for a row in the unified chat list. */
export type ChatItemKind = "topic" | "dm-user" | "dm-bot";

/**
 * Mirrors {@link ChatItem} from `@/lib/chat-list`. Defined here as well so
 * `<ChatListItem />` is self-contained and importable from a Storybook-style
 * sandbox without pulling in the server helper.
 */
export type ChatItem = {
  kind: ChatItemKind;
  id: string;
  href: string;
  title: string;
  avatar: { url?: string | null; iconUrl?: string | null; emoji?: string | null };
  lastAt: string | null;
  lastPreview: string | null;
  unreadCount: number;
  isE2ee?: boolean;
  /** True for feed-style topics (kind === "topic" only). Drives the Feed filter. */
  isFeed?: boolean;
  /**
   * Topic description, only populated for `kind === "topic"` rows. Rendered
   * as the secondary line on E2EE topic rows (where we never see plaintext
   * server-side so there's no last-message preview to show).
   */
  description?: string | null;
};

export interface ChatListItemProps {
  item: ChatItem;
  /** Highlights the row when `href` matches the current route. */
  active: boolean;
}

/**
 * Compact relative-time formatter matching `TopicListItem`'s flavour but
 * cheaper: under a day → minutes/hours, otherwise the localized month/day.
 */
function formatLastAt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  if (Number.isNaN(ms)) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d`;
  // Older than a week → month + day (e.g. "Mar 4"). Localized via Intl.
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function initialsOf(title: string): string {
  return title.trim().slice(0, 1).toUpperCase() || "?";
}

/**
 * 36x36 avatar tile, fixed-shape so the row height stays consistent.
 * Falls back through avatar.url → avatar.iconUrl → emoji → kind-specific icon
 * → initials.
 */
function Avatar({ item }: { item: ChatItem }) {
  const url = item.avatar.url ?? item.avatar.iconUrl ?? null;
  if (url) {
    return (
      <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg bg-panel2">
        <img src={url} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }
  if (item.avatar.emoji) {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-panel2 text-lg">
        {item.avatar.emoji}
      </div>
    );
  }
  if (item.kind === "topic") {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-panel2 text-muted">
        <Hash className="h-4 w-4" />
      </div>
    );
  }
  if (item.kind === "dm-bot") {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-panel2 text-accent2">
        <BotIcon className="h-4 w-4" />
      </div>
    );
  }
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-panel2 text-sm font-semibold">
      {initialsOf(item.title)}
    </div>
  );
}

/**
 * Secondary line under the row title. Branches:
 *   - non-E2EE rows: plaintext `lastPreview` (current behavior).
 *   - E2EE topic rows: italic-muted `description` (single line, ellipsis);
 *     blank if no description.
 *   - E2EE DM rows (user or bot): always blank — title + lastAt + lock +
 *     unread badge carry the row.
 * The empty placeholder div is kept in the no-content cases so the row's
 * fixed 56px height stays consistent.
 */
function PreviewSlot({ item }: { item: ChatItem }) {
  if (item.isE2ee) {
    if (item.kind === "topic") {
      const desc = item.description?.trim();
      return (
        <div className="line-clamp-1 flex-1 truncate text-xs italic text-muted">
          {desc ?? ""}
        </div>
      );
    }
    // E2EE DMs: render an empty slot to preserve row height.
    return <div className="flex-1" />;
  }
  return (
    <div className="line-clamp-1 flex-1 truncate text-xs text-muted">
      {item.lastPreview ?? ""}
    </div>
  );
}

export function ChatListItem({ item, active }: ChatListItemProps) {
  const time = formatLastAt(item.lastAt);
  return (
    <Link
      href={item.href}
      // Fixed 56px row keeps the list visually rhythmic regardless of preview
      // length; truncation happens inside via min-w-0 + truncate.
      className={cn(
        "group flex h-14 items-center gap-3 rounded-lg px-2 transition",
        active ? "bg-panel2" : "hover:bg-panel2/60",
      )}
    >
      <Avatar item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <div className="truncate text-sm font-medium">{item.title}</div>
          {item.isE2ee && (
            <Lock
              className="h-3 w-3 shrink-0 text-accent2"
              aria-label="end-to-end encrypted"
            />
          )}
          {time && <div className="ml-auto shrink-0 pl-1 text-[11px] text-muted">{time}</div>}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <PreviewSlot item={item} />
          {item.unreadCount > 0 && (
            <div className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {item.unreadCount > 99 ? "99+" : item.unreadCount}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
