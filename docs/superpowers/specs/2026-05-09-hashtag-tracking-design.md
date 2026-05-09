# Hashtag Tracking & Search

**Date:** 2026-05-09  
**Status:** Approved for implementation

## Overview

Two tag formats extracted from messages and tracked per topic:

- `#hashtag` — free-form, any `#word` typed by users
- `$symbol` — admin-defined tickers linkable to a user or bot (vendor), unrecognized `$xxx` rendered as plain text

Features:
1. Tag cloud in topic profile modal — live-updated
2. Autocomplete while typing `#` or `$` in the composer
3. Clicking a tag activates filtered message view within the chat panel
4. `$symbol` filtered view includes a vendor profile card above results
5. Admin CRUD for symbols

---

## Data Model

### New table: `symbols`

```sql
CREATE TABLE symbols (
  id            SERIAL PRIMARY KEY,
  symbol        TEXT NOT NULL UNIQUE,       -- stored without $, e.g. "gv"
  name          TEXT NOT NULL,
  description   TEXT,
  linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### New column: `messages.hashtags text[]`

- Stores validated tags, e.g. `['#foo', '#bar', '$gv']`
- `$symbol` entries only included if the symbol exists in the `symbols` table at send time (validated client-side)
- GIN index: `CREATE INDEX messages_hashtags_gin ON messages USING GIN (hashtags)`
- Null/empty for messages with no tags, E2EE messages, or pre-feature messages with no backfill match

### Migration

1. Add `hashtags text[]` column to `messages`
2. Create `symbols` table
3. GIN index on `messages.hashtags`
4. Backfill `#hashtag` only (no `$symbol` backfill — symbols table empty at migration time):

```sql
UPDATE messages
SET hashtags = ARRAY(
  SELECT DISTINCT lower(m[1])
  FROM regexp_matches(search_text, '(#[a-zA-Z]\w*)', 'g') AS m
)
WHERE search_text IS NOT NULL
  AND search_text <> ''
  AND deleted_at IS NULL
  AND search_text ~ '#[a-zA-Z]';
```

---

## Extraction & Validation

Extraction happens **client-side** at message send time. The client:

1. Runs regex `/#([a-zA-Z]\w*)/g` and `/$([a-zA-Z]\w*)/g` on the composed message text
2. For `#tags`: includes all matches (lowercased)
3. For `$symbols`: filters against the local symbols context — only recognized symbols included
4. Deduplicates, max 20 tags per message
5. Sends `hashtags: string[]` in the message payload alongside `text`

**Server-side validation** (WS `MESSAGE_SEND` handler):
- Strip any entry not matching `^[#$][a-zA-Z]\w*$`
- Cap at 20 entries
- Store in `messages.hashtags` at insert time

`sendMessageSchema` gains `hashtags: z.array(z.string()).max(20).optional()`.

---

## API Surface

### Public

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/symbols` | All symbols with linked user `{ id, symbol, name, description, linkedUserId, linkedUser: { displayName, avatarUrl } }` |
| `GET` | `/api/topics/[id]/hashtags` | Tag cloud: `{ tag: string, count: number }[]` ordered by count desc, excludes deleted messages |
| `GET` | `/api/topics/[id]/messages?hashtag=%23foo` | Extends existing reply-thread route — adds `hashtag` param, filters `WHERE hashtags @> ARRAY['#foo']`, returns same decrypted message shape, ordered `createdAt DESC`, limit 50 |

### Admin

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/admin/symbols` | List all symbols (full detail) |
| `POST` | `/api/admin/symbols` | Create symbol |
| `PUT` | `/api/admin/symbols/[id]` | Update symbol |
| `DELETE` | `/api/admin/symbols/[id]` | Delete symbol |

---

## WebSocket Events

### Emitted by server

**`HASHTAG_CLOUD_UPDATE`** — broadcast to `topic:{id}` room when a message with hashtags is saved:
```ts
{ topicId: string, tags: string[] }  // tags from the new message only (delta)
```
Client increments counts for each tag in local state.

**`SYMBOLS_UPDATE`** — broadcast to all connected clients when admin creates/edits/deletes a symbol:
```ts
{}  // no payload — client re-fetches /api/symbols
```

Broadcast path: Next.js admin API route → Redis pubsub `SYMBOLS_UPDATE` channel → WS server receives → emits `SYMBOLS_UPDATE` to all connected clients. Same pattern as `BOT_MESSAGE_NEW`.

### Schema additions (`packages/shared/src/events.ts`)

```ts
// WS events
HASHTAG_CLOUD_UPDATE: "hashtag_cloud_update"
SYMBOLS_UPDATE: "symbols_update"

// Redis channels
SYMBOLS_UPDATE: "symbols_update"
```

---

## UI Components

### `useSymbols()` hook

- Fetches `/api/symbols` once on app boot
- Stores in React context (`SymbolsProvider`)
- Refreshes on `SYMBOLS_UPDATE` WS event
- Provides `isKnownSymbol(sym: string): boolean` and `getSymbol(sym: string): Symbol | undefined`

### `useTopicHashtags(topicId)` hook

- Fetches `/api/topics/[id]/hashtags` on mount
- Subscribes to `HASHTAG_CLOUD_UPDATE` for the current topic — merges delta into local state (increment counts, add new tags)
- Returns `{ tags: { tag: string, count: number }[] }`

### `TopicInfoModal` — tag cloud section

- Added below description
- `#tag` chips: muted neutral style, font-mono
- `$symbol` chips: accent-colored (gold/amber), shows linked user avatar (16px) if present
- Empty state: "No tags yet" if no tags in topic
- Click `#tag` → `onClose()` + `onHashtagFilter(tag)`
- Click `$symbol` → `onClose()` + `onHashtagFilter(tag)`

### Composer autocomplete

Triggered in the Tiptap editor when user types `#` or `$`. Reuses the existing `@mention` suggestion extension pattern.

- **`#` trigger**: filters local tag cloud (`useTopicHashtags`) by typed prefix, shows top 8 matches ranked by count
- **`$` trigger**: filters symbols context by typed prefix, shows name + linked user avatar
- Both: arrow keys to navigate, Enter to select, Escape to dismiss
- Selection inserts the full tag into editor content

### Chat panel — filtered mode

State: `hashtagFilter: string | null` in `TopicView`.

**Activation:** `onHashtagFilter(tag)` sets filter, fetches `/api/topics/[id]/messages?hashtag=tag`.

**Filtered view layout:**
1. Sticky banner below topic header: `"Filtered: #foo  ×"` — X clears filter
2. For `$symbol`: vendor card above message list showing symbol, name, description, linked user avatar + display name
3. Message list: same `MessageBubble` renderer, no scroll-to-bottom behavior
4. Composer hidden in filtered mode — restored when filter is cleared
4. Empty state: "No messages with #foo yet"

**Deactivation:** X in banner → clears filter, restores normal chat.

### `MarkdownContent` — updates

- `#tag` spans already have `class="hashtag-tag"` — add `data-tag="#word"` + `onClick` via delegated event listener → fires `HashtagClickContext`
- `$symbol` spans: check `isKnownSymbol(sym)` — if recognized, render styled with `class="symbol-tag" data-tag="$sym"`; if unrecognized, render as plain text (no span)
- `HashtagClickContext`: React context providing `onHashtagClick(tag: string)` — avoids prop drilling through the message renderer tree

---

## Admin Panel: `AdminSymbolsPanel`

Same pattern as existing admin panels (`AdminUsersForm`, `InvitesPanel`).

**List view:**
- Table: `$symbol` | Name | Description | Linked user | Actions
- Linked user shows avatar + display name, or "—" if none

**Create/Edit form:**
- Symbol input: prefix `$` shown as static label, user types the word (e.g. `gv`)
- Name: text input
- Description: optional textarea
- Linked user: search input → queries existing users by display name → select one
- Save → POST/PUT → broadcasts `SYMBOLS_UPDATE` to all clients

**Delete:**
- Confirmation prompt → DELETE → broadcasts `SYMBOLS_UPDATE`
- Note: deleting a symbol does NOT remove it from `messages.hashtags` — historical data preserved, it just stops rendering as styled in new messages

---

## File Map

| File | Change |
|------|--------|
| `packages/db/src/schema.ts` | Add `hashtags` column to `messages`, add `symbols` table |
| `packages/db/src/migrations/XXXX_hashtags_symbols.sql` | Migration + backfill |
| `packages/shared/src/events.ts` | Add `HASHTAG_CLOUD_UPDATE`, `SYMBOLS_UPDATE` |
| `apps/ws/src/messages.ts` | Accept + store `hashtags` on insert |
| `apps/ws/src/index.ts` | Emit `HASHTAG_CLOUD_UPDATE` after message save; emit `SYMBOLS_UPDATE` on admin symbol change |
| `apps/web/app/api/symbols/route.ts` | `GET /api/symbols` |
| `apps/web/app/api/topics/[id]/hashtags/route.ts` | `GET /api/topics/[id]/hashtags` |
| `apps/web/app/api/topics/[id]/messages/route.ts` | Add `?hashtag=` branch to existing route |
| `apps/web/app/api/admin/symbols/route.ts` | `GET`, `POST` |
| `apps/web/app/api/admin/symbols/[id]/route.ts` | `PUT`, `DELETE` |
| `apps/web/components/MarkdownContent.tsx` | `$symbol` recognition, click handlers, `HashtagClickContext` |
| `apps/web/components/TopicInfoModal.tsx` | Tag cloud section |
| `apps/web/components/TopicView.tsx` | `hashtagFilter` state, filtered view, vendor card |
| `apps/web/components/AdminSymbolsPanel.tsx` | New admin panel |
| `apps/web/hooks/useSymbols.ts` | New hook + context |
| `apps/web/hooks/useTopicHashtags.ts` | New hook |
| `apps/web/lib/tiptap/hashtag-suggestion.ts` | Autocomplete extension for `#` and `$` triggers |

---

## Out of Scope

- Cross-topic hashtag search (scoped to current topic only)
- Hashtag analytics / trending
- E2EE message hashtag extraction (impossible by design)
- `$symbol` backfill (symbols table empty at migration time)
