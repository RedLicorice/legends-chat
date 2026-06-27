// Server-side merge helper for the unified left-sidebar chat list.
//
// Combines accessible topics + accepted DM conversations (user + bot) into a
// single sorted feed. Consumed by `/` page (and `/dm` after the refactor) and
// passed to `<ChatListPane />` as `initialItems`.
//
// Reuses existing data sources — no duplicate DB queries:
//   - listTopicsForUser  (apps/web/lib/topics.ts)
//   - listConversations  (apps/web/lib/dm.ts) — now accepts an optional
//     `{ state }` filter so we can pull only accepted DMs here. Pending +
//     incoming "DM requests" surface in `<NotificationBell />` instead.

import { listTopicsForUser, type TopicListItem } from "@/lib/topics";
import { listConversations, type DmConversationView } from "@/lib/dm";

/** Discriminator for a row in the unified chat list. */
export type ChatItemKind = "topic" | "dm-user" | "dm-bot";

/**
 * Unified row shape consumed by `<ChatListItem />`.
 *
 * Field semantics:
 *   - `id`     — topic id for `topic`, dm conversation id for both DM kinds
 *   - `href`   — pre-built route for `<Link href>`; client never re-derives
 *   - `avatar` — at most one of url/iconUrl/emoji is meaningful; the row
 *                falls back through them in that order
 *   - `lastAt` — ISO 8601 string for client sort/format; null means "no
 *                activity yet" (sorted to the bottom of the list)
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
   * Topic description, only populated for `kind === "topic"` rows. Rendered as
   * the secondary line on E2EE topic rows in place of a last-message preview
   * (we never see plaintext server-side for those).
   */
  description?: string | null;
};

function topicToItem(t: TopicListItem): ChatItem {
  return {
    kind: "topic",
    id: t.id,
    href: `/t/${t.slug}`,
    title: t.title,
    avatar: { iconUrl: t.iconUrl ?? null },
    lastAt: t.lastMessage?.at ? t.lastMessage.at.toISOString() : null,
    // E2EE topics never get a server-side last-message preview (we can't
    // decrypt ciphertext); the renderer falls back to `description` instead.
    lastPreview: t.isE2ee ? null : t.lastMessage?.preview ?? t.description ?? null,
    unreadCount: t.unreadCount,
    isE2ee: t.isE2ee,
    isFeed: t.isFeed,
    description: t.description ?? null,
  };
}

function dmToItem(c: DmConversationView): ChatItem | null {
  if (!c.peer) return null;
  const kind: ChatItemKind = c.peer.type === "bot" ? "dm-bot" : "dm-user";
  return {
    kind,
    id: c.id,
    // DM conversations live under `/c/<id>` (the "c" namespace covers all
    // 1:1 chats — user-to-user and user-to-bot — at the URL layer).
    // AppSidebar / ChatListPane just navigate to `href`.
    href: `/c/${c.id}`,
    title: c.peer.displayName,
    avatar: { url: c.peer.avatarUrl },
    lastAt: c.lastMessageAt,
    // E2EE DMs render no preview at all — the row keeps title + lastAt + lock.
    // Non-E2EE DMs don't currently surface a preview either (no field on the
    // server view yet), but the renderer is preview-aware once that lands.
    lastPreview: null,
    unreadCount: 0, // DM unread counts not yet tracked server-side
    isE2ee: c.isE2ee,
    description: null,
  };
}

/** Stable "lastAt DESC NULLS LAST" then "title ASC" comparator. */
function compareChatItems(a: ChatItem, b: ChatItem): number {
  if (a.lastAt && b.lastAt) {
    // ISO 8601 strings compare lexicographically the same way as Dates.
    if (a.lastAt > b.lastAt) return -1;
    if (a.lastAt < b.lastAt) return 1;
  } else if (a.lastAt) {
    return -1;
  } else if (b.lastAt) {
    return 1;
  }
  return a.title.localeCompare(b.title);
}

/**
 * Build the unified chat list for `userId`.
 *
 * Topics and DMs are fetched in parallel — both helpers do their own DB I/O so
 * we don't try to share a transaction. Errors from either side currently
 * bubble; the caller (server component) wraps this in a Suspense boundary so a
 * thrown error renders the error.tsx fallback.
 */
export async function listChatItems(
  userId: string,
  userRole: string,
  userPermissions: Set<string>,
): Promise<ChatItem[]> {
  const [topics, dms] = await Promise.all([
    listTopicsForUser(userId, userRole, userPermissions),
    listConversations(userId, { state: "accepted" }),
  ]);
  const items: ChatItem[] = [];
  for (const t of topics) items.push(topicToItem(t));
  for (const c of dms) {
    const row = dmToItem(c);
    if (row) items.push(row);
  }
  items.sort(compareChatItems);
  return items;
}
