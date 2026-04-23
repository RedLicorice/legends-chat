# Legends Chat — Architecture & Build Plan

## Context

PWA chat app for a single community (one workspace, many "topic" rooms — Telegram-forum style). Auth is delegated to a Telegram bot via one-time invite/login codes. Roles: User / Moderator / Admin. Bots are first-class with a Telegram-inspired API. Hosting is containerized and horizontally scalable.

E2EE is now implemented as a per-topic admin toggle. The at-rest encryption layer was always there; the toggle controls whether the server decrypts for previews/search (non-E2EE) or stores only ciphertext the server cannot read (E2EE). Client-side key management is future work.

## Decisions locked in

- **Stack**: Next.js 15 (App Router) PWA, TypeScript, Tailwind, Postgres + Drizzle ORM, Socket.IO over HTTPS, Redis (pub/sub for WS fanout + ephemeral state), Web Push (VAPID).
- **Telegram bot**: separate Node process using **grammY**, sharing types and Drizzle schema via workspace package. Supports both polling and webhook mode (`BOT_MODE=webhook`); webhook URL auto-registers from `APP_PUBLIC_URL`/ngrok at startup.
- **Hosting**: Docker Compose for dev (postgres + redis); production = horizontally scalable containers.
- **E2EE**: per-topic toggle in admin. `isE2ee=true` topics store ciphertext the server never decrypts; server shows "(encrypted)" as preview, unread count still tracked server-side. Client-side ratchet/key-exchange deferred to future work.
- **Onboarding**: Telegram bot is gated. New user DMs `/start` → bot reads `registration_config` (invites-only / public / closed) → if invites: asks for code → code validated → account created → bot returns login deep link. Existing user `/start` → fresh login link. All registration modes configurable from admin settings.
- **Topics**: forum-style rooms. Per-topic: sticky flag, feed mode (one-way broadcast), home topic, E2EE toggle, read-role gate, post-role gate, retention policy (none / age / count), manual purge. Unread count tracked server-side via `last_read_message_id` per (user, topic).
- **Role/permission gates**: `readRoles` and `postRoles` are jsonb arrays on each topic. Empty = everyone. Non-empty = only listed roles may read/post. Enforced at both list and view level server-side. Admins bypass read gates.

## Repo layout (monorepo, pnpm workspaces)

```
legends-chat/
├── apps/
│   ├── web/              # Next.js 15 PWA (App Router)
│   ├── ws/               # Socket.IO server (separate process)
│   └── bot/              # grammY Telegram bot (polling or webhook mode)
├── packages/
│   ├── db/               # Drizzle schema + migrations + client
│   ├── shared/           # Zod schemas, shared types, permission constants, event names
│   ├── crypto/           # XChaCha20-Poly1305 wrapper for encryption at rest
│   └── ui/               # shared components
├── docker-compose.yml
└── pnpm-workspace.yaml
```

## Data model (Drizzle, Postgres) — current state

- `users` — id, telegramUserId (unique), telegramUsername, displayName, avatarUrl, role, isAnonymous, presenceOptOut, createdAt, lastSeenAt
- `roles_permissions` — role → permission key mapping (seeded, admin-tunable)
- `invite_codes` — code, createdByUserId, role granted, maxUses, usesCount, expiresAt, createdAt
- `invite_quota_config` — role, dailyLimit
- `auth_login_tokens` — token, userId, expiresAt, consumedAt, telegramChatId, telegramMessageId
- `sessions` — id, userId, refreshTokenHash, deviceLabel, createdAt, revokedAt
- `encryption_keys` — id, purpose (`messages` | `attachments`), algorithm, wrappedKey, createdAt, rotatedAt
- `topics` — id, slug, title, description, isSticky, sortOrder, isE2ee, historyVisibleToNewMembers, autoDeleteMode (`none`|`age`|`count`), autoDeleteAgeSeconds, autoDeleteMaxMessages, isFeed, isHomeTopic, postRoles (jsonb), readRoles (jsonb), createdAt
- `topic_members` — topicId, userId, joinedAt, lastReadMessageId
- `messages` — id, topicId, senderUserId, botId, replyToMessageId, contentCiphertext (bytea), contentNonce (bytea), keyId, searchVector (tsvector — populated on insert for non-E2EE topics), createdAt, editedAt, deletedAt
- `user_key_bundles` — userId (PK FK), identityPublicKey (SPKI base64 of P-256 ECDH key), keyBundle (jsonb — stores passphrase-encrypted backup blob), createdAt, updatedAt
- `e2ee_sender_keys` — id, topicId, distributorUserId, recipientUserId, encryptedKey (base64 — ECDH-AES-GCM wrapped sender key), keyVersion, createdAt; unique on (topicId, distributorUserId, recipientUserId)
- `message_reactions` — messageId, userId, emoji, createdAt
- `message_flags` — id, messageId, reporterUserId, reason, status (`pending`|`dismissed`|`actioned`), reviewedByUserId, reviewedAt, createdAt
- `user_bans` — id, userId, bannedByUserId, reason, sourceFlagId, createdAt, expiresAt, liftedByUserId, liftedAt
- `user_mutes` — same shape as user_bans
- `bots` — id, name, ownerUserId, tokenHash, avatarUrl, isActive, createdAt
- `push_subscriptions` — userId, endpoint, p256dh, auth, deviceLabel
- `polls` — id, topicId, messageId, question, createdAt, closedAt
- `poll_options` — id, pollId, text, sortOrder
- `poll_votes` — pollId, userId, optionId, createdAt
- `audit_log` — actorUserId, action, targetType, targetId, metadata, createdAt
- `registration_config` — singleton: invitesEnabled, publicRegistrationEnabled
- `system_settings` — key/value store for admin-configurable settings (default_topic_id, welcome_message, etc.)

Permission keys: `topics.create`, `messages.delete.any`, `invites.create`, `bots.manage`, `messages.flag`, `moderation.queue.review`, `users.ban.direct`, `users.ban.lift`, `users.mute.direct`, `users.mute.lift`, `admin.config`.

## Auth flow

1. User DMs Telegram bot.
2. `/start` → ban check → registration policy check → invite code flow or public registration.
3. Bot generates `auth_login_tokens` row (32-byte random, 5-min TTL) and replies with login deep link (inline keyboard button for HTTPS, plain text for localhost).
4. Web `/auth/callback` consumes token → issues access JWT (15 min, httpOnly) + refresh JWT (30 days, httpOnly). Refresh token hash stored in `sessions`.
5. Socket.IO middleware verifies access JWT from cookie (no DB hit). Revocation via Redis jti blocklist.

**Ban enforcement**: banning atomically inserts `user_bans`, adds all active session jtis to Redis revocation set, publishes `user:banned` for WS disconnect.

**Mute enforcement**: muted user keeps session and read access; server rejects all write attempts (`message:send`, `reaction:add`, `messages.flag`) with `MUTED` error.

## Realtime layer

Socket.IO server (`apps/ws`) with Redis adapter for horizontal scaling. Rooms: `topic:<id>`, `user:<id>`.

Events: `message:new`, `message:edit`, `message:delete`, `reaction:add`, `reaction:remove`, `topic:read`, `presence:update`, `typing:start`, `typing:stop`, `bot:keyboard:callback`.

## Encryption

### At rest (always on)

Every message stored as XChaCha20-Poly1305 ciphertext+nonce. Per-message random nonce. AAD = topicId. Master key from env wraps row keys in `encryption_keys`. Key rotation = new row, old rows still decryptable via keyId FK.

### E2EE (per topic — fully implemented)

**Key model**: simplified Signal sender key. Each user has a P-256 ECDH identity key pair registered with the server (`user_key_bundles`). Per topic, each sender generates a random AES-GCM-256 "sender key". On first send, the sender distributes their key to all current topic members: for each member, ECDH(senderPriv, recipientPub) → AES-GCM wraps sender key → stored in `e2ee_sender_keys`. New members who join later cannot decrypt history (no retroactive distribution).

**Message format**: client encrypts message `{"e":1,"kid":"<senderUserId>","iv":"<base64>","ct":"<base64>"}` → this JSON is the plaintext that the server wraps with XChaCha20 (outer layer). Other clients receive the outer-decrypted JSON and do the inner AES-GCM decryption with the cached sender key.

**Key storage**: private key stored in IndexedDB via Web Crypto API (extractable). If user has a permanent account, they can create a passphrase-backed PBKDF2+AES-GCM encrypted backup stored on the server in `user_key_bundles.keyBundle`.

**Toggle behavior**: admin enabling E2EE on a topic that has messages triggers a wipe (user confirms in UI). Client-side setup modal (`E2EESetup`) shown on first entry to an E2EE topic if no key registered.

**No search in E2EE topics**: `search_vector` is never populated for E2EE messages.

## Auto-delete worker

Runs inside `apps/ws`. Age mode: 60s tick, hard-delete messages older than `autoDeleteAgeSeconds`. Count mode: triggered per-insert, hard-delete messages beyond `autoDeleteMaxMessages` (keep most recent N). Emits `message:delete` over Socket.IO. Manual purge also available via `DELETE /api/admin/topics/[id]/messages`.

## Bot API (internal — Telegram-inspired)

`apps/web/app/api/bot/v1/...`. Bots authenticate with `Authorization: Bearer <bot-token>`.

Endpoints (Slice 2):
- `POST /sendMessage` — `{topicId, text, replyToMessageId?, inlineKeyboard?}`
- `POST /editMessage`, `POST /deleteMessage`
- `POST /answerCallbackQuery`
- `POST /setWebhook` — server POSTs updates to bot's URL
- `GET /getMe`, `GET /getUpdates` (long-poll fallback)

Events delivered to bot webhooks: `message`, `callback_query`, `member_joined`, `member_left`. Payload shape mirrors Telegram's Update object. Bots scoped to topics via `topic_bots` join table. Adding a bot to an E2EE topic is rejected.

---

## Slice status

### Slice 1 — ✅ Complete

- Monorepo scaffold, Docker Compose (postgres + redis + web + ws + bot)
- Drizzle schema + migrations + seed
- grammY bot: `/start`, invite-code flow, login link, ban check, anonymous user (`/anon`)
- JWT auth (access + refresh, jti revocation via Redis)
- Topic list (sticky-first, unread badges, last-message preview), topic view
- Socket.IO + Redis adapter, message send/receive/delete/edit
- Reactions (quick picker, live broadcast)
- Message reporting → moderation queue (dismiss / delete message / ban user / mute user)
- Ban + mute with session revocation + socket disconnect
- Auto-delete worker (age mode 60s tick, count mode per-insert)
- Web Push (VAPID subscribe, service worker, server-side delivery)
- PWA manifest + service worker
- Admin API endpoints (topics, invites, bans, mutes, moderation actions)

### Slice 1.5 — ✅ Complete

- Admin UI: topics (E2EE, feed, home, sticky, read/post roles, retention, purge), users, settings, invites, moderation queue
- Rich messaging: GIF picker, emoji picker, polls, rich text editor, file upload
- User profile modal, topic sidebar, mod queue modal
- ngrok dev tunneling (auto-updates bot login URL)
- Bot webhook mode (`BOT_MODE=webhook`, auto-registers URL at startup)
- Per-topic E2EE toggle, readRoles/postRoles gates enforced server-side
- Admin sidebar navigation fixes

### Slice 1.75 — ✅ Complete

- **E2EE client-side key exchange**: P-256 ECDH identity keys, per-sender AES-GCM-256 sender keys per topic, ECDH-based key distribution to all current members, IndexedDB key storage, passphrase backup via PBKDF2+AES-GCM. `E2EESetup` modal on first E2EE topic entry. Wipe-on-enable with admin confirmation. Zero new npm dependencies (Web Crypto API only).
- **Full-text search**: `search_vector tsvector` on messages, populated on insert for non-E2EE topics. `GET /api/search?q=...&topic=...` endpoint. `SearchModal` component, accessible via search button in topic header or Ctrl+K.
- **Thread/reply UI**: reply button on messages, inline quote preview showing parent excerpt, `replyToMessageId` passed through WS on send. `ThreadPanel` side panel for viewing thread replies (opens when a message has 3+ replies via "View thread (N)" button). `GET /api/topics/[id]/messages?replyTo=<id>` endpoint for loading thread replies.

### Slice 2 — 🔲 Next

**Internal bot API + bot management**

- `apps/web/app/api/bot/v1/` endpoints (sendMessage, editMessage, deleteMessage, answerCallbackQuery, setWebhook)
- `topic_bots` join table — scopes bots to topics, rejects E2EE topics
- Bot management UI: create bot, rotate token, set webhook URL, assign to topics
- Webhook delivery worker: fan-out relevant Socket.IO events to registered bot webhooks
- Inline keyboard rendering + `bot:keyboard:callback` Socket.IO handler
- Bot API auth middleware (Bearer token → `bots` table lookup)

### Slice 3 — 🔲 Planned

**Notifications + account linking + 2FA**

- **Notification system**: in-app FB-style notification feed (no badges — dot or banner only). Triggers: mentions, replies, topic activity based on user prefs. Notification table + Socket.IO `notification:new` event + mark-read flow.
- **Permanent accounts / email linking**: after Telegram login, prompt user to link an email address for account recovery. Repeating reminder (dismissable with "not again") until linked or dismissed. Email OTP flow for verification.
- **OTP / 2FA via Authy (TOTP)**: optional for user login, required for critical operations (ban, role change, invite code generation for non-user roles). TOTP secret stored encrypted; QR enroll flow in user settings.

### Slice 4 — 🔲 Planned

**Shop system**

- **Roles**: `shop:owner` (can create shops), `shop:(shopname):owner` (manages specific shop), `shop:(shopname):user` (can view specific shop). Dynamic roles require extending the current fixed enum — likely a `user_roles` table with a `type` column (`builtin` | `shop`) replacing the enum, or a separate `shop_memberships` table.
- **Store editor**: storefront image upload, product list (name, description, price, image), interactive image map drawn by owner (click-drag regions linked to product IDs). Stored as `shops`, `shop_products`, `shop_image_hotspots` tables.
- **Storefront integration**: users who are `shop:(shopname):owner` with an active shop show a special badge in chat. Clicking the badge opens the shop view. Only users with `shop:(shopname):user` (or `shop:owner`) can see/open the shop.
- Shop visibility enforced same way as topic readRoles — server-side filter on shop list and direct URL access.

### Future (not sliced yet)

- **E2EE key rotation**: on new member join, current senders rotate sender keys and re-distribute to all members. Requires sender key versioning and per-message key version header.
- **E2EE for bots**: bots excluded from E2EE topics (current constraint). Full bot E2EE would require bot-side key management outside scope.
- **Search**: full-text search over non-E2EE messages (Postgres `tsvector` or Meilisearch sidecar).
- **Thread/reply UI**: collapse reply chains inline, jump-to-parent.
- **Attachment previews**: image/video inline, file type icons.
