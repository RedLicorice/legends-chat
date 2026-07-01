# Changelog — 2026-06-11

## 1:1 Direct Messages

End-to-end build-out of the DM subsystem from spec to a Matrix-crypto E2EE
implementation, unified sidebar surface, and the `/dm` → `/c` URL rename.
Covers commits from 2026-05-28 through 2026-06-10.

### Spec & plans

- `docs/spec/...` — `1770ee4` lands the **1:1 DM subsystem design** doc.
  Sets the per-flavor scope (plaintext user↔user, plaintext bot, E2EE
  user↔user), the principal model (`user|bot`), and the
  `dm_conversations`/`dm_participants`/`dm_messages`/`dm_blocks` table
  shape that the schema commit consumes.
- `55f8d99` — **Plan A** plaintext core doc.
- `b2d3c77` — **Plan C** plaintext bot DMs doc.
- `9cfc317` — **Plan B** opt-in user-user E2EE doc.
- `9375cd7` — Plan B superseded: switch from a hand-rolled scheme to a
  Signal/Olm Double Ratchet implementation.
- `be0f530` — Plan B retired in favor of **Plan B'**: drop
  `@matrix-org/olm` and adopt `matrix-sdk-crypto-wasm` (vodozemac) to share
  one crypto stack with the upcoming Megolm topic work.

### Schema & data layer

- **Migration `0035_direct_messages.sql`** (`0cb6a32`,
  `packages/db/src/migrations/0035_direct_messages.sql`).
  - Introduces two enums: `dm_principal_type` (`user|bot`) and `dm_state`
    (`pending|accepted|blocked`).
  - `dm_conversations` — `dm_key text NOT NULL UNIQUE`, `is_e2ee`, `state`,
    `initiator_type`, `initiator_id`, `last_message_at`. The `dm_key`
    column is the deterministic, order-independent token pair built by
    `buildDmKey` in `packages/db/src/dm-key.ts` (TDD-verified pure helper,
    see `packages/db/src/dm-key.test.ts`); the `UNIQUE` index makes "open
    DM" idempotent.
  - `dm_participants` — composite PK `(conversation_id, principal_type,
    principal_id)`, with a `last_read_message_id bigint` watermark. Indexed
    on `(principal_type, principal_id)` for the per-user list query.
  - `dm_messages` — `bigserial id`, `content_ciphertext bytea`,
    `content_nonce bytea`, `key_id uuid REFERENCES encryption_keys`. At-rest
    encryption reuses the existing per-topic data-key scheme.
  - `dm_blocks` — symmetric block table keyed on `(blocker_user_id,
    blocked_user_id)`.
- `e3083e7` — rename the message index from a created-at name to
  `dm_messages_conv_created_idx ON (conversation_id, id)`. The `id` column
  is a `bigserial`, so it already encodes insertion order; using it for
  the cursor instead of the timestamp eliminates a sort tie-breaker.
- `f72bc75` adds **`0036_bots_dm_enabled.sql`** — single boolean
  `bots.dm_enabled` toggle so admins can flip a bot into the DM principal
  set.
- `2cd7df4` adds **`0037_dm_double_ratchet_prekeys.sql`** — Plan B
  prekey/identity tables (kept for the Olm interim, then superseded).
- `be0f530` adds **`0038_dm_matrix_crypto.sql`** and
  **`0039_crypto_sent_txns.sql`**. 0038 reshapes `user_key_bundles` to a
  Matrix-style `(user_id, device_id)` composite PK with JSON columns for
  algorithms/keys/signatures/fallback_key, rebuilds `user_one_time_prekeys`
  with a partial-unique on unused keys, and adds `user_to_device_queue`
  (broadcast + per-device fan-out with a `delivered_at` watermark),
  `dm_conversations.e2ee_room_id`, and `dm_messages.ciphertext_json` with
  an XOR CHECK against `octet_length(content_ciphertext)`. 0039 adds
  `crypto_sent_txns` for `sendToDevice` idempotency.
- `330bb38` adds **`0040_dm_request_notifications.sql`** — backfills one
  `dm_request` notification per existing pending DM, addressed to the
  non-initiator participant.

### Realtime relay

- `d5bd7aa` (`packages/shared/src/events.ts:16`) — five new WS event
  constants: `DM_NEW`, `DM_EDIT`, `DM_DELETE`, `DM_READ`, `DM_REQUEST`;
  and four Redis channels: `DM_MESSAGE_NEW`, `DM_MESSAGE_EDIT`,
  `DM_MESSAGE_DELETE`, `DM_REQUEST_NEW`.
- `43ec6cd` (`apps/ws/src/index.ts`) — subscribes the new Redis channels
  and relays DM message events to every participant's user-room. No topic
  membership check, no broadcast — each conversation maps to exactly two
  rooms.
- `330bb38` adds `DM_CONVERSATION_UPDATED` (WS) +
  `legends:dm:conversation:updated` (Redis) so accept/decline/block
  transitions reach the sidebar live
  (`packages/shared/src/events.ts:24`/`:78`).
- `e8f8da9` adds `TOPIC_MEMBERS_UPDATED` (DM-adjacent but used by E2EE
  rotation; covered in the E2EE changelog).

### Plaintext DMs (Plan A)

- **`apps/web/lib/dm.ts`** (`1191bf3`) — server helpers:
  `openConversation`, `listConversations`, `acceptConversation`,
  `blockUser`, `markRead`, plus the participant + block guards.
- **`apps/web/lib/dm.codec.ts`** — minimal plaintext envelope codec; same
  data-key wrap path as topic messages, so DM ciphertext at rest uses the
  same XChaCha20-Poly1305 stream the rest of the app already does.
- **API routes**:
  - `apps/web/app/api/dm/route.ts` — `POST` opens or returns the existing
    conversation; `GET` lists.
  - `apps/web/app/api/dm/[id]/messages/route.ts` — `GET` paginates with a
    `before-cursor` BigInt guard; `POST` inserts, wraps at rest, fans out
    via `DM_MESSAGE_NEW`.
  - `apps/web/app/api/dm/[id]/accept/route.ts`,
    `apps/web/app/api/dm/[id]/block/route.ts`,
    `apps/web/app/api/dm/[id]/read/route.ts`.
  - `apps/web/app/api/dm/search/route.ts` — rate-limited user search
    (`897365c`).
- **Client UI**: `apps/web/components/DmClient.tsx` (initial single-pane
  list + thread + requests bucket + composer), `useDmSocket.ts` hook
  (stable socket connection, dedup by id), `/dm` page route.
  `apps/web/components/AppSidebar.tsx` gains a "Direct Messages" footer
  entry.
- **Review fixes folded in**:
  - Sender double-append dedup (own send echoes via WS).
  - BigInt input guards on the `before-cursor`, `replyTo`,
    `lastReadMessageId` paths.
  - Stable socket: switching conversations does not reconnect.
- `078b4ee` (`apps/web/app/api/dm/search/route.ts:+1`) caps the search
  query at 64 chars. Stops a malformed query from driving a wide
  `ILIKE` scan against `users`.
- `3aa7d33` (`apps/web/components/DmClient.tsx`,
  `apps/web/middleware.ts:+1`):
  - DmClient collapses to a single pane below `md`; thread gets a Back
    button on mobile. Realtime delivery verified on 390×844.
  - Middleware `PUBLIC_PATHS` adds `/api/bot/`. The bot HTTP routes
    authenticate via Bearer token in `apps/web/lib/bot-auth.ts`, not the
    `lc_access` cookie — the middleware gate was 401-ing every bot API
    call. Pre-existing for topic send; needed now for the bot-DM send
    path landing in Plan C.

### Bot DMs (Plan C)

`f72bc75` adds plaintext bot DMs. Bots can now sit on either side of a
`dm_principal_type` row.

- **Schema**: `0036_bots_dm_enabled.sql` adds `bots.dm_enabled` (default
  false). `lib/dm.openConversation` accepts a `peerType: "user" | "bot"`
  argument; `lib/dm.listConversations` resolves bot peers from the
  `bots` table.
- **API**: `apps/web/app/api/dm/route.ts:+5` accepts `peerType="bot"`;
  `apps/web/app/api/dm/search/route.ts:+5` returns dm-enabled bots
  alongside users.
- **Bot HTTP send** (`apps/web/app/api/bot/v1/sendMessage/route.ts`)
  gains a `conversationId` branch: cached data key lookup,
  `AAD=conversationId`, codec wrap, BigInt guard on `replyToMessageId`.
  The topic branch is preserved unchanged.
- **Delivery glue** (`apps/web/lib/dm-bot-delivery.ts`): on every new
  user-to-bot DM, push a `dm_message` Update envelope onto the existing
  `legends:bot:updates:<botId>` Redis queue and POST `webhookUrl`. Same
  contract as topic messages; SDK consumers don't see new shapes for
  DMs, just a new envelope kind.
- **SDK** (`packages/bot-sdk/src/{bot,client,index,types}.ts`):
  `DmMessageUpdate`, `SendDmMessageParams`, `sendDmMessage`,
  `DmMessageContext`, and `on("dm_message", ...)` handler.
- **Client**: `DmClient.tsx` renders bot peers with a "BOT" badge;
  `?tab=bots` lands directly on the Bots filter. `AppSidebar` gains a
  Bots entry.
- **Explicitly deferred**: E2EE bot DMs and bot-initiated DMs (bot
  reaches out first).

### E2EE DMs (Plan B → B')

#### Plan B — Olm Double Ratchet (interim)

- `2cd7df4` ships opt-in Signal-style Double Ratchet on top of the
  separate DM subsystem via `@matrix-org/olm` (audited C++/WASM port).
  `apps/web/public/olm.wasm` (153 KB) shipped to the public dir.
- Migration `0037_dm_double_ratchet_prekeys.sql`: repurpose
  `user_key_bundles.signed_prekey*` for Olm identity (Curve25519 +
  Ed25519); add `user_one_time_prekeys` with atomic `FOR UPDATE SKIP
  LOCKED` consumption.
- Routes (interim): `apps/web/app/api/user/keys/prekeys/route.ts` and
  `apps/web/app/api/user/keys/bundle/route.ts` (UUID-validated, 30/min
  rate limit).
- Client (`apps/web/lib/dm-olm.ts`) — lazy-load Olm WASM. Every
  `Account`/`Session` is `.free()`'d after pickling to avoid WASM heap
  leaks; sessions are re-pickled after every encrypt/decrypt; IndexedDB
  persistence.
- DmClient gains: dynamic import of the wrapper, first-time setup gate,
  `conversationsRef` pattern to dodge stale closure on freshly-created
  E2EE threads, lock indicator, safety-number modal (peer Ed25519
  fingerprint stored alongside the session so it's available on
  re-open).
- Bot HTTP route's E2EE rejection remains in force — bots stay plaintext.
- Bounded scope: one device per user; signed-prekey rotation, fallback
  key, multi-device, cross-device history, and bot-as-Olm-endpoint all
  deferred.

#### Plan B' — `matrix-sdk-crypto-wasm` (final)

`be0f530` retires `@matrix-org/olm` in favor of
`@matrix-org/matrix-sdk-crypto-wasm` (vodozemac, NCC-audited). **This is
the production path.** Same wrapper now serves DMs and the upcoming
Megolm topics — no second crypto library to maintain.

- Not a Matrix server. A thin adapter maps Legends Chat IDs into
  `@user:legends.local` / `!room:legends.local` purely so the
  `OlmMachine` API can route them.
- **Schema** (0038 + 0039):
  - `user_key_bundles`: composite PK `(user_id, device_id)`,
    Matrix-shaped `algorithms_json` / `keys_json` / `signatures_json`
    / `fallback_key_json`. The legacy topic sender-key slot is
    namespaced to `device_id='legacy-topic'` until Plan D retires it.
  - `user_one_time_prekeys`: composite PK `(user_id, device_id,
    key_id)`, `jsonb key_json` + `algorithm`; partial-unique on unused
    keys.
  - `user_to_device_queue`: Matrix to-device fan-out with broadcast
    (`"*"`) + per-device routing and a `delivered_at` watermark.
  - `crypto_sent_txns`: `sendToDevice` idempotency tracker.
  - `dm_conversations.e2ee_room_id`,
    `dm_messages.ciphertext_json` with the XOR CHECK against
    `octet_length(content_ciphertext)`.
- **Server endpoints** (under `apps/web/app/api/crypto/`):
  - `POST keys/upload`, `keys/query`, `keys/claim` (atomic OTK pop via
    `FOR UPDATE SKIP LOCKED`, fallback-key reuse).
  - `PUT sendToDevice/[event_type]/[txn_id]` (idempotent via
    `crypto_sent_txns`; requires `x-legends-crypto-device-id` header).
  - `GET sync?since=&device_id=` — drains the to-device queue, returns
    OTK counts and fallback status.
- **Client wrapper** (`apps/web/lib/dm-crypto.ts`, later renamed to
  `apps/web/lib/crypto.ts` by Plan D):
  - Per-(user, browser) singleton `OlmMachine` with stable base32
    `deviceId` and ISO sync cursor persisted to IndexedDB.
  - `init`, `bootstrap`, `ensurePeerTracked`,
    `ensureSessionWithPeer`, `pumpOutgoing`, `encryptDm` (Megolm),
    `decryptDm`, `pollSync`, ed25519 fingerprint helpers.
- **DmClient wiring**: setup gate, encrypted toggle, lock indicator,
  safety-number modal preserved; internals swapped. 5-second
  `pollSync` gated by Page Visibility; locked rows retry decrypt on
  every tick so late-arriving room keys auto-unlock. One-shot retry on
  send if no peer session yet.
- **Cleanup**: delete `apps/web/lib/dm-olm.ts` and
  `apps/web/app/api/user/keys/{bundle,prekeys}/route.ts`. Plan B doc
  marked superseded.
- Live two-user desktop + mobile + refresh + negative tests pass.

### Unified sidebar + ChatPane

- `330bb38` collapses the split sidebars (`/`, `/dm`, `/dm?tab=bots`)
  into a single chat list.
  - `apps/web/components/ChatListPane.tsx` + `ChatListItem.tsx`:
    shared left pane (search input, filter chip row All / Topics / DMs
    / Bots, merged sorted list, lock chip for E2EE rows). URL-syncs the
    chip via `?filter=`. Live updates via `SIDEBAR_UPDATE` (topics) +
    `DM_NEW` (DMs) + `DM_CONVERSATION_UPDATED` (accept/decline).
  - `apps/web/components/ChatLayout.tsx`: server shell wrapping
    `ChatListPane` + right pane; auto-closes the mobile overlay on
    route change.
  - `apps/web/components/DmThreadPane.tsx`: split out from the old
    `DmClient` — thread + composer only, list logic gone.
  - `apps/web/components/NewChatModal.tsx`: "+" opens a debounced
    user/bot search modal with optional Encrypted toggle.
  - `apps/web/components/NotificationBell.tsx`: new `dm_request`
    render branch with Accept/Decline pill buttons and lock icon when
    `is_e2ee`. On action, dispatches a `chatlist:refresh`
    `CustomEvent` so the pane re-syncs.
  - `AppSidebar.tsx` drops the DM and Bots footer links — filter
    chips replace them.
  - `apps/web/components/DmClient.tsx` deleted; `/dm` redirects to
    `/?filter=dms`.
- `apps/web/lib/dm-requests.ts` — emits `dm_request` notifications on
  the existing `NOTIFICATION_BROADCAST` channel, plus
  `publishDmConversationUpdated` for accept/decline live signal.
- `302c90a` eliminates the DM-vs-Topic chat body duplication. **Single
  `apps/web/components/ChatPane.tsx`** (renamed from `TopicView.tsx`)
  renders both topic and DM bodies.
  - Discriminated `mode: { kind: "topic" | "dm" }` prop plus a
    `source: ChatSource` adapter and `chatCrypto: ChatCrypto | null`.
  - Two `ChatSource` impls under `apps/web/lib/chat-source/`:
    `topic.ts` wires `TOPIC_JOIN` bootstrap + `MESSAGE_NEW/EDIT/DELETE`
    + `REACTION_*` + `GET /api/topics/[id]/messages`; `dm.ts` wires
    `DM_NEW/EDIT/DELETE` + `GET/POST /api/dm/[id]/messages`.
  - Each source exposes a `capabilities` set (edit, delete, reactions,
    polls, hashtags, mentions, members, presence, threads). Topic =
    all true. DM = all false today — no DM-side backend for
    edit/delete/reactions/polls yet, so the UI is feature-gated rather
    than silently no-op.
  - `apps/web/lib/chat-crypto.ts` abstracts the E2EE round-trip:
    `createMegolmChatCrypto(roomId)` for topics,
    `createOlmChatCrypto(roomKey, peerId)` for 1:1 DMs. Both delegate
    to `apps/web/lib/crypto.ts`.
  - `apps/web/components/DmThreadPane.tsx` deleted (-498 LoC); the
    "request to chat" / accept / decline / block screen for
    non-accepted DMs becomes an early-return inside ChatPane when
    `mode.kind === "dm"`.
  - Capability gating hides ~20 UI sites a DM can't honor: react
    button + picker + chips, reply + thread + replying-to banner,
    edit/delete context menu + multi-select delete, polls, mention
    picker, hashtag autocomplete + filter + cloud, members button +
    panel + search modal + Ctrl+K, ThreadPanel.

### URL rename `/dm` → `/c`

`ac02511` (frontend only).

- DM URL slug renamed from `/dm` to `/c`. The backend keeps
  `/api/dm/...` and the in-code `kind: "dm"` discriminator unchanged.
- `apps/web/components/AppShell.tsx:141-156` — route table swaps
  `path === "/dm"` → `"/c"` and `path.startsWith("/dm/")` →
  `"/c/"`. Slice offset corrected (`path.slice(3)` because `/c/` is
  three chars).
- **Backward-compat redirect** in the same file: a `useEffect` watches
  `pathname` and `router.replace`s `/dm` → `/c` and `/dm/<id>` →
  `/c/<id>`. `replace`, not `push`, so the legacy URL doesn't sit in
  history and Back skips it. Old PWA shortcuts, pasted links, and push
  notifications still land correctly.
