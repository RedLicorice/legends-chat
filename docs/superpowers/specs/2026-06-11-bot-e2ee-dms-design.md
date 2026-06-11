# Bot E2EE — DMs and Topic Channels

**Date:** 2026-06-11
**Status:** approved (brainstorming complete; awaiting implementation plan)
**Scope:** 1:1 direct messages **and** E2EE topic channel membership
**Out of scope:** group DM bots, multi-replica bots, per-message forward secrecy, plaintext-to-E2EE migration

---

## 1. Motivation and trust model

Bot DMs are plaintext today. Existing E2EE infrastructure (Matrix Olm / Megolm via `@matrix-org/matrix-sdk-crypto-wasm`) is restricted to user clients. The current rejection lives at `apps/web/lib/dm.ts:86` (`peer.type === "bot" && options?.e2ee` → `BAD`).

Bots are **external entities**. They run as independent processes, often off the chat operator's infrastructure. Extending E2EE to bots without preserving that boundary (e.g., by giving the chat server a copy of the bot's private key, or by relaying decrypted plaintext through an admin-keyed bridge) would expand the trusted-recipient set and break the "server cannot read E2EE content" property.

Therefore: **the bot SDK runs its own Olm device**. The chat server stores only the bot's public identity key. The server's role for bot E2EE is identical to its role for user E2EE — ciphertext relay and to-device queue.

E2EE participation is **opt-in per bot**, toggled by an administrator in the bot's settings.

---

## 2. Architectural shape

Four moving parts:

1. **`@legends/bot-sdk` Olm support** (new submodule `packages/bot-sdk/src/crypto/*`). Wraps `matrix-sdk-crypto-wasm`. FS-persisted pickle store. Transparent encrypt/decrypt around the existing handler API — bot authors keep writing `ctx.reply("hello")`; the SDK handles crypto when the conversation is E2EE.
2. **Server `/api/bot/v1/crypto/*` mirror** of the existing user `/api/crypto/*` surface, bearer-auth via the bot's token. Writes/reads dedicated `bot_*` tables; never touches `user_devices`.
3. **Schema additions** for bot crypto state (state machine column on `bots`) and bot crypto material (three new tables).
4. **DM open path** in `apps/web/lib/dm.ts` extended to consult the bot's `e2ee_state` instead of unconditionally rejecting bot+E2EE.

The thin dispatch layer `apps/web/lib/crypto-principal.ts` lets a single user-facing API resolve recipients of either principal type (user or bot) so a user opening an E2EE DM with a bot looks identical, server-side, to a user opening an E2EE DM with another user.

---

## 3. Identity model

- **One Olm device per bot.** Identity key + prekeys live in a pickle file written by the SDK to `${BOT_DATA_DIR}/olm-store.pickle` (configurable). Default: same directory the bot SDK writes other state to.
- Bot SDK supports **single-process operation only** for v1. Multi-replica HA requires a shared / locked store; this is out of scope.
- The server records the bot's `device_id` in `bots.e2ee_device_id` once the bot's first `keys/upload` succeeds.

### Matrix-id namespacing

The existing `crypto-matrix.ts` helper formats user ids as `@<userUuid>:legends.local`. Bots need a distinguishable namespace:

- **User**: `@<userUuid>:legends.local` (unchanged)
- **Bot**: `@bot.<botUuid>:legends.local`

New helpers `toMatrixBotId(botId)` / `fromMatrixBotId(matrixId)` land alongside the existing user helpers. The existing user regex stays UUID-only and so does not accidentally match the bot namespace.

---

## 4. State machine

`bots.e2ee_state text NOT NULL DEFAULT 'disabled'` with check constraint `IN ('disabled','pending','ready')`.

| From | To | Trigger |
|---|---|---|
| `disabled` | `pending` | Admin flips toggle in `/admin/bots/[id]` |
| `pending` | `ready` | Bot SDK uploads ≥1 device key + ≥10 one-time keys via `keys/upload` |
| `ready` | `disabled` | Admin flips toggle off — blocks **new** E2EE conversation opens; **does not** purge existing keys, so in-flight E2EE DMs and topic memberships keep working until the operator hard-resets |
| `disabled` | `pending` | Admin re-enables — server keeps existing `bot_devices` row; bot re-uses its existing pickle if present (idempotent re-upload) |
| any | `pending` | Admin clicks "rotate bot E2EE identity" — server **deletes** `bot_devices` + `bot_one_time_keys` rows for that bot, sets state back to `pending`. Bot SDK detects missing device on next `keys/query` self-check, wipes local pickle, bootstraps fresh |

Operational rule: a stuck `pending` (bot offline indefinitely) is harmless. The flag activates whenever the bot reconnects. Admin UI shows the current state with a badge (`Disabled` / `Pending bot upload` / `Ready`).

---

## 5. Schema

### `bots` (modified)

Add columns:
- `e2ee_state text NOT NULL DEFAULT 'disabled' CHECK (e2ee_state IN ('disabled','pending','ready'))`
- `e2ee_device_id text` (nullable; FK-like reference to `bot_devices.device_id`, populated on first successful upload)

### `bot_devices` (new)

Shape mirrors `user_devices`:

```sql
CREATE TABLE bot_devices (
  bot_id     uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  device_id  text NOT NULL,
  algorithms text[] NOT NULL,
  identity_keys jsonb NOT NULL,
  signatures jsonb,
  unsigned jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, device_id)
);
CREATE INDEX bot_devices_bot_id_idx ON bot_devices(bot_id);
```

### `bot_one_time_keys` (new)

```sql
CREATE TABLE bot_one_time_keys (
  bot_id    uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  key_id    text NOT NULL,
  algorithm text NOT NULL,
  key_json  jsonb NOT NULL,
  claimed_at timestamptz,
  PRIMARY KEY (bot_id, device_id, key_id)
);
CREATE INDEX bot_one_time_keys_unclaimed_idx
  ON bot_one_time_keys(bot_id, device_id)
  WHERE claimed_at IS NULL;
```

### `bot_to_device_queue` (new)

Mirrors `user_to_device_queue` shape:

```sql
CREATE TABLE bot_to_device_queue (
  id          bigserial PRIMARY KEY,
  bot_id      uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  device_id   text NOT NULL,
  event_type  text NOT NULL,
  sender_user_id  uuid,
  sender_bot_id   uuid,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (sender_user_id IS NOT NULL AND sender_bot_id IS NULL) OR
    (sender_user_id IS NULL AND sender_bot_id IS NOT NULL)
  )
);
CREATE INDEX bot_to_device_queue_bot_idx ON bot_to_device_queue(bot_id, id);
```

### `bot_crypto_sent_txns` (new)

Idempotency for the bot side, mirroring `crypto_sent_txns`:

```sql
CREATE TABLE bot_crypto_sent_txns (
  bot_id     uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  txn_id     text NOT NULL,
  event_type text NOT NULL,
  body_hash  bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, txn_id)
);
```

Migration file: `packages/db/src/migrations/0045_bot_e2ee.sql`.

---

## 6. Server API surface

All routes are bearer-authenticated by the bot's existing token (`apps/web/lib/bot-auth.ts`). Shapes match the user-side `/api/crypto/*` routes one-for-one — the server-side handler differs only in *which tables* it touches (dispatched via `crypto-principal.ts`).

| Route | Purpose |
|---|---|
| `POST /api/bot/v1/crypto/keys/upload` | Bot publishes its identity key + signed device + one-time keys. On first success, transitions `bots.e2ee_state` to `ready` and sets `e2ee_device_id`. Replay-safe (idempotent if same device + identity key). |
| `POST /api/bot/v1/crypto/keys/query` | Bot queries one or more peer identity-key bundles (users or other bots) by Matrix id. |
| `POST /api/bot/v1/crypto/keys/claim` | Bot claims a peer's one-time key for starting a new Olm session. |
| `PUT /api/bot/v1/crypto/sendToDevice/[event_type]/[txn_id]` | Bot pushes an envelope (Olm-wrapped m.room_key, key-request, etc.) to a peer device. Server enqueues to `user_to_device_queue` or `bot_to_device_queue` depending on recipient principal type. Idempotent on `(bot_id, txn_id)`. |
| `GET  /api/bot/v1/crypto/sync` | Long-poll: server drains the bot's `bot_to_device_queue` and returns the envelopes. |
| `GET  /api/bot/v1/crypto/rooms/[roomId]` | Returns the room member list (user / bot principals + device ids) so the bot can target Megolm session shares correctly. |
| `POST /api/bot/v1/dm/[id]/messages` | Mirror of `/api/dm/[id]/messages` but bot-authenticated and accepting `ciphertext` for E2EE conversations (alongside the existing plaintext `text` for non-E2EE). |

### Modifications to existing user-side routes

- **`/api/crypto/keys/query`** — when the requested Matrix id parses as `@bot.<uuid>:legends.local`, dispatch to `bot_devices` via `crypto-principal.ts`.
- **`/api/crypto/sendToDevice/[event_type]/[txn_id]`** — when recipient parses as a bot principal, write to `bot_to_device_queue` instead of `user_to_device_queue`. Idempotency continues to live in `crypto_sent_txns` (sender side; sender is still a user here).

---

## 7. Data flow

### User opens E2EE DM with a bot

```
client                                server                                bot
─────                                  ──────                                ───
POST /api/dm/open
{peer:{type:"bot",id}, e2ee:true}
                              dm.ts: bot.e2ee_state===?
                                'ready'    → create dm_conversations row
                                            (isE2ee=true, e2eeRoomId=!<convId>:legends.local)
                                            return 200 {convId, e2eeRoomId}
                                'pending'  → 400 bot_e2ee_not_ready
                                'disabled' → 400 bot_e2ee_disabled

client establishes Megolm session
POST /api/crypto/keys/claim {bot OTK}
POST /api/crypto/sendToDevice/m.room_key/<txn>
  {messages: { "@bot.<id>:legends.local":
              { <botDeviceId>: <olm-wrapped m.room_key> }}}
                              → bot_to_device_queue insert

POST /api/dm/[id]/messages {ciphertext}
                              → dm_messages insert (ciphertext-only)
                              → deliverDmToBots forwards ciphertext to bot via Redis queue

                                                          GET /api/bot/v1/crypto/sync
                                                          ← drains m.room_key envelope
                                                          SDK: olm.processToDevice → Megolm session ready

                                                          GET /api/bot/v1/getUpdates
                                                          ← dm_message {ciphertext}
                                                          SDK: megolm.decrypt → plaintext to handler
```

### Bot replies (E2EE DM)

```
SDK: ctx.reply("ack")
  1. ensure outbound Megolm session for the room (rotate if needed)
  2. POST /api/bot/v1/crypto/keys/query {user_id}   → user device list
  3. POST /api/bot/v1/crypto/sendToDevice/m.room_key/<txn>
       (one Olm-wrapped session per user device, queued to user_to_device_queue)
  4. POST /api/bot/v1/dm/[id]/messages {ciphertext}
       → server insert, ws emits DM_NEW to user (ciphertext payload)
       → user browser uses existing E2EE DM decrypt path (no changes)
```

### Bot added to E2EE topic

```
admin: POST /api/admin/topics/[id]/bots {botId}
  server:
    1. assert bot.e2ee_state==='ready' (else 400 bot_e2ee_required)
    2. topic_bots insert
    3. emit synthetic m.room.member event to existing members' sync
       so their clients trigger Megolm room-key rotation
    4. when each member's client uploads a new outbound key share
       targeting the bot's device, server routes those envelopes
       to bot_to_device_queue (same as DM path)

bot:
  GET /api/bot/v1/crypto/sync → drains new m.room_key
  GET /api/bot/v1/getUpdates → topic message envelopes (ciphertext)
  SDK: decrypt → invoke message handler
```

### Bot removed from E2EE topic

`topic_bots` delete → server emits member-leave event → remaining members rotate. Bot keeps its decrypted history of past messages it already received. Future messages are encrypted with a key the bot never receives. (Symmetric with how user removal works today.)

---

## 8. SDK behavior

`packages/bot-sdk/src/bot.ts` (`LegendsBot` constructor + `start()`):

1. Call `getMe()` — response now includes `e2ee_state` and `e2ee_device_id`.
2. If `e2ee_state === 'disabled'` → no crypto module loaded. SDK behaves exactly as today (plaintext only).
3. If `e2ee_state === 'pending'`:
   - Load or create local pickle.
   - If pickle absent: `OlmMachine` bootstrap → publish device + one-time keys via `keys/upload`. On 200, transition observed in next `getMe()` poll.
   - If pickle present (re-enable case): verify server has the device; if missing, re-upload.
4. If `e2ee_state === 'ready'`:
   - Load pickle. If absent or device mismatch: refuse to start with a fatal log instructing the operator to run rotation. (Pickle corrupted/deleted but server still has the device row = irrecoverable; rotation is the answer.)
5. Spawn a background loop polling `/api/bot/v1/crypto/sync` to drain to-device envelopes.
6. Top up one-time keys when server-side count drops below threshold (server returns count in `sync` response; SDK re-uploads when below 5).

`handleUpdate()` gains a pre-process step for E2EE DMs and topic channels: incoming envelope's `ciphertext` is decrypted before `MessageContext` / `DmMessageContext` is constructed. From the handler's perspective the plaintext is transparent.

`ctx.reply()` / `ctx.send()` gain a pre-send step: if the conversation/topic is E2EE, encrypt the outgoing plaintext through Megolm and POST `{ciphertext}` instead of `{text}`.

---

## 9. Admin UI

`AdminBotsView` lists bots; each row gets an E2EE column:

- Badge: `Disabled` / `Pending bot upload` / `Ready` (color matches existing role-status badges).
- Detail panel `AdminBotsE2eeSection.tsx`:
  - Primary toggle: "End-to-end encryption" (switch reflecting `e2ee_state !== 'disabled'`).
  - Destructive action: "Rotate identity" button (only shown when state is `ready` or `pending` and a device row exists). Confirmation modal explains: "Forces the bot to wipe its local Olm pickle and bootstrap a fresh identity. Existing E2EE conversations will be lost."
  - Read-only fields: `device_id`, `identity_key_fingerprint` (truncated Ed25519 fp), `last_keys_upload_at`.

Server endpoint: `PATCH /api/admin/bots/[id]/e2ee` accepts `{ enabled: boolean }` or `{ rotate: true }`. Authz: `bot.manage` (existing permission).

---

## 10. Existing plaintext bot DMs

Stay plaintext. Per-conversation immutable flag (`dm_conversations.is_e2ee`) already enforces side-by-side: if a user opens a new E2EE conversation with a bot that they previously had a plaintext conversation with, they get a **second** `dm_conversations` row. Same model as user↔user today. No migration script, no auto-upgrade.

The sidebar groups by `peer + is_e2ee`; an E2EE conversation with a bot renders with the existing lock badge and blur placeholder for any message that fails to decrypt (no UX change required on the renderer side).

---

## 11. Error handling

| Condition | HTTP | Error code | Recovery |
|---|---|---|---|
| User opens E2EE DM, bot `e2ee_state=disabled` | 400 | `bot_e2ee_disabled` | User asks admin to enable E2EE on the bot |
| User opens E2EE DM, bot `e2ee_state=pending` | 400 | `bot_e2ee_not_ready` | Wait for bot to publish keys, or admin checks bot health |
| Admin adds bot to E2EE topic, bot not ready | 400 | `bot_e2ee_required` | Same as above |
| Bot `keys/upload` validation fails | 422 | `crypto_keys_invalid` | SDK retries with exponential backoff; surfaces error in bot author's log |
| Bot `sendToDevice` to user OTK exhausted | 404 | `otk_unavailable` | SDK falls back to existing Olm session if present; else drops message and logs |
| Bot SDK Olm pickle corrupt | n/a | n/a | SDK refuses to start; operator deletes pickle + uses admin rotation |
| Bot decrypt fails (missing room key) | n/a | n/a | SDK logs and drops the update; message stays undecryptable until a new key arrives (matches user UX) |
| Server `sendToDevice` recipient not found | 404 | `device_not_found` | Sender retries `keys/query` and re-targets |
| `sendToDevice` replay (same `txn_id`) | 200 | n/a | Idempotent — `bot_crypto_sent_txns` returns no-op |

---

## 12. Testing

### Unit (`packages/bot-sdk/test/crypto/`)

- `OlmStore` round-trip: pickle save → load returns identical machine state.
- `bootstrap()` on empty store creates a device with non-empty identity keys; on populated store loads existing.
- `processToDevice()` consumes m.room_key, exposes resulting Megolm session.
- `encryptMessage()` / `decryptMessage()` round-trip against a peer fake.

### Integration (`apps/web/__tests__/e2ee-bots/`)

- State-machine transitions: `disabled → pending → ready → disabled → pending` (re-enable) → `ready` again via re-upload.
- Open E2EE DM with bot in each state — assert correct status + error code.
- Round-trip: user encrypts → server queues → fake bot SDK decrypts to expected plaintext. Reverse path.
- Topic bot membership: bot added with `ready` succeeds, with non-ready returns `bot_e2ee_required`. Removal triggers member event.
- Hard-reset: existing `bot_devices` row deleted → user clients receive next message back with `device_not_found` on `sendToDevice` (graceful failure).
- Idempotency: replay `sendToDevice` with same `txn_id` returns 200 + no duplicate queue entry.

### E2E (`tests/e2e/bot-e2ee.spec.ts` w/ chrome-devtools MCP)

- Boot `apps/bots/jane` configured with E2EE enabled.
- Browser as user opens E2EE DM with jane → exchanges 2 messages each direction → assert both render decrypted (no blur placeholder, no "Locked" pill) and that the server's `dm_messages.ciphertext` column is non-null for every row.
- Browser flow respects the test-budget cap (≤30 min); inline curl/psql checks run first per memory `feedback_test_budget`.

---

## 13. Out of scope (explicit non-goals)

- **Multi-replica bots.** Single-process SDK only. Pluggable storage adapter (Redis, Postgres) is a follow-up.
- **Per-message forward secrecy.** Session-level FS only — matches the current user E2EE limitation.
- **Auto-migration** of pre-existing plaintext bot DMs.
- **Per-bot-instance** identity (one device per bot, not per replica).
- **Group DM bots.** 1:1 DM only. Topics covered via Megolm-room membership.
- **PDF / document E2EE inside bot DMs.** Inherits whatever the broader upload pipeline supports.

---

## 14. Trust model recap

After this lands, the following statements remain true even when the chat server is hostile:

- The server cannot read plaintext of any E2EE bot DM.
- The server cannot read plaintext of any E2EE topic message a bot is a member of.
- The server **can** see who DMs whom, when, and the size of envelopes (unchanged; same as user E2EE DMs).
- The server **can** insert spurious member events into Megolm rooms (admin-recipient pattern) — operators can already do this for users; the same applies to bots. This is documented in the whitepaper.
- Compromising a bot's host gives the attacker the bot's Olm pickle and therefore the ability to decrypt past + future messages in conversations that bot is a member of. There is no per-message ratchet to mitigate. Operators should treat bot hosts as sensitive.
