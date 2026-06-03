# Unified Chats Sidebar

## Context
Legends Chat currently has split sidebars: `/` shows topics (HomeLayout), `/dm` shows DMs with a tab toggle for bots (DmClient). User dislikes split. Wants one unified list.

## Goal
- One unified chat list in left sidebar containing topics + 1:1 DMs (users) + bot DMs, sorted by last activity descending.
- Thin filter chip bar above list: All | Topics | DMs | Bots.
- Search input above list: case-insensitive substring filter against topic title OR peer displayName (user or bot).
- DM requests (state=pending, incoming) NOT shown in sidebar. Instead surfaced as new "dm_request" notifications in `NotificationBell` with Accept/Decline inline. On Accept → conversation appears in unified list (after state→accepted) + notif marked read. On Decline → block sender (existing dm_blocks insert) + notif marked read.

## Current state (from explore)
- `apps/web/components/AppSidebar.tsx` — shell with header (NotificationBell), children slot, footer with Home/DM/Bots links (lines 290-302)
- `apps/web/components/HomeLayout.tsx` — renders topics-only list, fed by `initialTopics` + socket SIDEBAR_UPDATE
- `apps/web/components/DmClient.tsx` — renders DM list + thread; tab state from `?tab=bots`; renders requests section in sidebar (lines 479-488)
- `apps/web/components/NotificationBell.tsx` — types `"mention" | "reply" | "broadcast"`; no dm_request type yet
- `apps/web/components/SearchModal.tsx` — message search only, NOT used here
- Notifications fed via `/api/user/notifications` + socket NOTIFICATION_NEW

## Architecture
- New `apps/web/components/ChatListPane.tsx` — full pane: filter chips + search + merged sorted list. Takes `initialItems` from server (parallel fetch topics + DMs in page server-component).
- New `apps/web/components/ChatListItem.tsx` — one item, renders topic OR user-DM OR bot-DM with type-appropriate icon (Hash for topic, user avatar for DM, Bot icon for bot DM), unread badge, last message preview, lastAt.
- Routes:
  - `/` — unified pane on left, welcome on right
  - `/t/<slug>` — unified pane on left, TopicView on right
  - `/dm/<id>` — unified pane on left, DM thread (existing DmClient ThreadPane portion) on right
  - `/dm` (no id) — equivalent to `/` with filter chip preset to "DMs"; redirects to `/?filter=dms`
  - `/dm?tab=bots` (legacy) → 302 redirect to `/?filter=bots`
- Right pane state determined by URL, not local state.
- `DmClient.tsx` to be split into:
  - `DmThreadPane.tsx` — message thread only (no list, no requests)
  - List logic gone (subsumed by ChatListPane)

## Backend additions
- `dm_request` added to notifications type enum (Postgres + Zod schemas + TS type).
- New migration `0040_dm_request_notifications.sql`:
  - `ALTER TYPE notification_type ADD VALUE 'dm_request';`
  - Backfill: for each existing `dm_conversations` row where state=pending AND there is an incoming participant (recipient), insert a notification for that recipient.
- New helper `apps/web/lib/dm-requests.ts` (or extend `dm.ts`):
  - `emitDmRequestNotification(conversationId, recipientUserId, senderDisplayName)` — insert notification row + emit NOTIFICATION_NEW socket event.
  - Called from `openConversation` when a new pending conversation is created.
- New endpoints:
  - `POST /api/dm/[id]/accept` — recipient only; sets state=accepted, returns conversation. Marks any dm_request notif for this convId as read.
  - `POST /api/dm/[id]/decline` — recipient only; blocks sender (insert dm_blocks row blocker=me blocked=peer), soft-deletes conversation (or marks state=blocked), marks notif read.

## Frontend data fetch
- Server component for `/` page (`apps/web/app/page.tsx`) parallel-fetches:
  - topics list (existing)
  - DM conversations (accepted only, exclude bot if user wants, but include all by default with type tagging)
- Hands to `ChatListPane` as `initialItems`.
- Type:
  ```ts
  type ChatItem = {
    kind: "topic" | "dm-user" | "dm-bot";
    id: string;               // topic id or conversation id
    href: string;             // /t/<slug> or /dm/<id>
    title: string;
    avatar: { url?: string; iconUrl?: string; emoji?: string };
    lastAt: string | null;    // ISO
    lastPreview: string | null;
    unreadCount: number;
    isE2ee?: boolean;
  };
  ```
- Sort: `lastAt DESC NULLS LAST`.
- Filter chips: client state `filter: "all" | "topics" | "dms" | "bots"`. URL param `?filter=` syncs.
- Search: client state `query: string`, ~120ms debounced; case-insensitive substring on `title`.

## Real-time updates
- Subscribe to:
  - `WS_EVENTS.SIDEBAR_UPDATE` (topic last message preview + unread) — existing
  - `WS_EVENTS.DM_MESSAGE_NEW` (or whatever name; check apps/ws/src/index.ts) → bump conversation's lastAt + preview
  - `WS_EVENTS.NOTIFICATION_NEW` → if type=dm_request, re-fetch notifications (already wired in NotificationBell)
- Items list re-sorted on any change.

## NotificationBell rendering
- Extend `Notification.type` to include `"dm_request"`. Payload: `{conversationId, senderUserId, senderDisplayName, senderAvatarUrl?, isE2ee?}`.
- Render dm_request items with:
  - Avatar + senderName + "wants to message you"
  - Accept button (POST /api/dm/[id]/accept) → on success, navigate to /dm/<id> and close dropdown
  - Decline button (POST /api/dm/[id]/decline)
  - Both actions optimistically mark notification read.

## Mobile single-pane
- ChatListPane is the same DOM in mobile + desktop. AppSidebar's existing overlay pattern carries over (slides in from left).
- Filter chips stack horizontally inside the sidebar (scroll if overflow).

## AppSidebar footer
- Drop "Direct Messages" and "Bots" footer links (they were navigation shortcuts; now redundant with filter chips).
- Keep "Home" + other footer items.

## Compat
- `/dm` (no id) → redirect to `/?filter=dms` (kept for back-compat with bookmarks).
- `/dm?tab=bots` → redirect to `/?filter=bots`.

## Test plan
- Two users.
- A sends new DM request to B → B sees notification with Accept button. B's sidebar does NOT show pending conv.
- B accepts → conv appears in B's sidebar; notif marked read; A sees no change (already in sidebar).
- B replies → A's sidebar bumps DM to top.
- Filter chips: All shows everything; Topics hides DMs/bots; DMs shows users only; Bots shows bots only.
- Search "use" against test users including "TestUser" → matches both users with that substring; against topic "general" → matches topic.
- Mobile: open sidebar overlay, see filter chips, search input, list. Tap an item → right pane.
- Negative: B declines instead → A's DM creation succeeds but no thread persisted for B; A's side shows blocked or unchanged (define behavior).

## Task breakdown (subagent-driven, parallelized, commit at end only)
1. (this doc)
2. Backend: notif type + migration + backfill + emit helper + accept/decline endpoints
3. Frontend: ChatListPane + ChatListItem + page-level data fetch + AppSidebar wiring
4. Frontend: NotificationBell dm_request renderer + actions
5. Refactor: split DmClient into DmThreadPane (no sidebar), repoint /dm route; HomeLayout drops topic-only list
6. Live two-user browser + mobile test
7. Single commit

## Open Qs (default decisions, redirect if wrong)
- Search scope = local string match for v1 (server search later if needed)
- Decline = block + soft-delete conv. Reversible via unblock UI later.
- Bot DMs: always plaintext (existing constraint preserved), 🤖 icon distinguishes
- E2EE indicator on item: 🔒 chip on the chat row if convo.isE2ee

## Risks
- Backfill query needs to identify "incoming" participant correctly. Conversation has 2+ participants; the recipient = participants minus initiator. Need to track initiator (look for `created_by` or initiator participant column on dm_conversations).
- Real-time DM new-message socket event may not exist yet — verify and add if missing.
- Topic + DM unread counts need consistent semantics (last_read_message_id pattern).

## Test users
- A, B from prior tests (Test User, E2E TestUser).
