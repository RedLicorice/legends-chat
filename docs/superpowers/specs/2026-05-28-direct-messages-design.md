# Direct Messages (1:1) — Subsystem Design

**Date:** 2026-05-28
**Status:** Approved
**Scope:** A self-contained 1:1 DM subsystem (user↔user and user↔bot), default plaintext with optional E2EE, that does NOT reuse or modify the existing topics/messages/group-E2EE machinery.

---

## Background

The platform today has only **topics** (group channels). There is no 1:1 DM concept, no user-facing user directory (search is admin-only), and no user-facing way to create a conversation (topic creation is admin-only). Messages live in the `messages` table (always at-rest encrypted with the server master key via `@legends/crypto`); E2EE topics additionally wrap a client-side sender-key envelope inside that at-rest ciphertext. Bots interact only inside topics they are assigned to, over a plaintext REST/webhook transport, and are blocked from E2EE topics.

This is the first sub-project of a larger effort to port the `telegram-physical-shop` bot onto the platform. DMs are a prerequisite foundation. A later sub-project covers E2EE bot endpoints and the shop bot itself; both are **out of scope here**.

### Decision history (why this shape)

The design went through several reversals during brainstorming. The settled decisions:

- **Separate subsystem, not a special topic.** Piggybacking DMs on `topics`/`messages`/`e2eeSenderKeys` was rejected as too invasive — it would mutate the table that powers group E2EE, require filtering DMs out of every topic listing, and bolt participant/permission guards onto shared websocket paths. DMs get their own tables, routes, ws events, and UI.
- **Default plaintext, optional E2EE.** An earlier "E2EE for every peer" hard requirement was dropped. DMs are server-readable (at-rest only) by default; E2EE is opt-in, user↔user only, fixed at creation.
- **Plaintext bot DMs are in scope.** Because non-E2EE DMs are server-readable, a bot can participate with no keypair/crypto — just conversationId addressing on the bot API. E2EE bot DMs (bot-as-crypto-endpoint) are deferred.

---

## Goals

| Property | Result |
|---|---|
| 1:1 user↔user DMs | New, isolated subsystem |
| 1:1 user↔bot DMs | Plaintext only, this phase |
| Encryption | Plaintext by default; opt-in sender-key E2EE (user↔user) |
| Existing topics/group-E2EE | **Untouched** |
| Discovery | Open user search (rate-limited) + request/accept + block |
| Multi-device | Inherit current per-device-key model (no new crypto) |
| Sidebar | Topics (default) + "Direct Messages" tab + "Bots" tab |

---

## Non-goals (explicitly deferred)

- E2EE **bot** DMs (bot keypair, `bot_key_bundles` registry, lifting any E2EE block). Bots are plaintext-only here.
- The shop bot port and any SDK editable-keyboard / media / payments work.
- Per-message forward secrecy / Double Ratchet (DMs reuse the existing sender-key model when E2EE).
- Switching an existing conversation between plaintext and E2EE after creation (`isE2ee` is fixed at creation).
- Group DMs / >2 participants.
- DM message search and inline keyboards in DMs.

---

## Data model

All new tables. Naming/conventions mirror the existing schema (`packages/db/src/schema.ts`): `uuid` PKs for externally-addressed rows, `bigserial` for ordered message rows, `bytea` for ciphertext/nonce, `keyId` referencing `encryptionKeys`.

### `dm_conversations`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | used in URLs / ws room name |
| `dmKey` | text, **unique** | deterministic sorted principal pair → idempotent open |
| `isE2ee` | boolean, default `false` | fixed at creation |
| `state` | enum `pending\|accepted\|blocked` | request/accept lifecycle |
| `initiatorType` | enum `user\|bot` | who opened it |
| `initiatorId` | text | principal id (uuid string) |
| `createdAt` | timestamptz | |
| `lastMessageAt` | timestamptz, null | for list ordering |

`dmKey` format: each principal rendered as `u:<userId>` or `b:<botId>`, the two sorted lexicographically and joined with `|`. Example: `b:<botId>|u:<userId>`. A unique constraint on `dmKey` guarantees one conversation per pair.

### `dm_participants`
| Column | Type | Notes |
|---|---|---|
| `conversationId` | uuid → dm_conversations (cascade) | |
| `principalType` | enum `user\|bot` | |
| `principalId` | text | uuid string |
| `lastReadMessageId` | bigint, null | read high-water-mark |
| PK | `(conversationId, principalType, principalId)` | exactly 2 rows per conversation |

A principal model (rather than two `userId` columns) handles user↔user and user↔bot uniformly and keeps read state per participant.

### `dm_messages`
| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | ordering |
| `conversationId` | uuid → dm_conversations (cascade) | |
| `senderType` | enum `user\|bot` | |
| `senderId` | text | uuid string |
| `contentCiphertext` | bytea | **always** at-rest encrypted |
| `contentNonce` | bytea | |
| `keyId` | uuid → encryptionKeys | at-rest data key |
| `replyToMessageId` | bigint, null | |
| `createdAt` | timestamptz | |
| `editedAt` | timestamptz, null | |
| `deletedAt` | timestamptz, null | soft delete |

Content is **always** at-rest encrypted with `@legends/crypto` (same as `messages`). For a plaintext conversation the decrypted-at-rest value is the real text (server-readable). For an E2EE conversation it is a client sender-key envelope (`{e:1,kid,iv,ct}`) the server cannot read. No `inline_keyboard`, no `searchVector` (DM search is out of scope).

### `dm_sender_keys` (E2EE conversations only)
| Column | Type | Notes |
|---|---|---|
| `conversationId` | uuid → dm_conversations (cascade) | |
| `distributorUserId` | uuid → users | |
| `recipientUserId` | uuid → users | |
| `encryptedKey` | text | base64, ECDH-wrapped sender key |
| `keyVersion` | int | |
| unique | `(conversationId, distributorUserId, recipientUserId)` | upsert on rotation |

DM-local. The shared `e2eeSenderKeys` table is **not** read or written by this subsystem.

### `dm_blocks`
| Column | Type | Notes |
|---|---|---|
| `blockerUserId` | uuid → users | |
| `blockedUserId` | uuid → users | |
| `createdAt` | timestamptz | |
| PK | `(blockerUserId, blockedUserId)` | |

### `bots.dmEnabled`
New boolean column on the existing `bots` table — opts a bot into being discoverable/DM-able. Default `false`.

---

## Encryption model

- **Plaintext (default):** content stored at-rest-encrypted only; server can read it after at-rest decryption. Enables push previews with text, link processing, and bot participation.
- **E2EE (opt-in, user↔user only):** reuses the existing **sender-key** primitives — `apps/web/lib/e2ee.ts` (P-256 ECDH + AES-GCM, envelope encode/decode, TOFU pinning, safety number), the user's identity keypair (IndexedDB), and the shared `userKeyBundles` public-key registry (one identity per user, shared with group E2EE — this is identity, not group machinery). Keys are distributed via the DM-local `dm_sender_keys` table and DM `/keys` routes, never the shared `e2eeSenderKeys`.
- `isE2ee` is chosen at conversation creation and **fixed**. Bot conversations are always `isE2ee=false` this phase.
- **Peer-without-keys sequencing:** if the initiator requests E2EE but the recipient has no registered pubkey yet, the conversation is created E2EE but the initiator's sender key cannot be wrapped to the recipient until the recipient sets up keys. The recipient completes `E2EESetup` on **accept**; the initiator's next send (or rotation) distributes the sender key, retroactively unlocking the intro message (same sender key, pre-rotation). Reuses the existing `E2EESetup`/`E2EEKeyWarning` components unchanged.

---

## Discovery + request/accept

- `GET /api/dm/search?q=` — user-facing, **rate-limited**. Reuses the admin `ilike(displayName)` logic but exposed to normal users; excludes self, banned users, users who have blocked the caller, and (for bots) bots without `dmEnabled`. Returns users + dm-enabled bots.
- `POST /api/dm { peerType, peerId, e2ee? }` — computes `dmKey`, upserts the conversation (idempotent). user↔user → `state=pending` (unless already accepted), `isE2ee` from the `e2ee` flag. user↔bot → `state=accepted` (bots auto-accept), `isE2ee=false`. Returns `conversationId`. If the caller is blocked by the peer, returns the existing thread in `blocked` state and rejects sends.
- `POST /api/dm/[id]/accept` — recipient flips `pending → accepted`; thread moves from the Requests bucket to the DM list.
- `POST /api/dm/[id]/block` — `blocked` + a `dm_blocks` row.
- Until accepted, the initiator may send (messages stored); the recipient sees them only after accepting.

---

## API surface

| Route | Method | Purpose |
|---|---|---|
| `/api/dm/search` | GET | rate-limited user/bot search |
| `/api/dm` | POST | open/upsert a conversation (idempotent via `dmKey`) |
| `/api/dm` | GET | list conversations (accepted) + requests bucket |
| `/api/dm/[id]/messages` | GET | paginated history |
| `/api/dm/[id]/messages` | POST | send (fallback to ws; see transport) |
| `/api/dm/[id]/accept` | POST | accept a pending request |
| `/api/dm/[id]/block` | POST | block the peer |
| `/api/dm/[id]/read` | POST | advance `lastReadMessageId` |
| `/api/dm/[id]/keys` | GET/POST | E2EE only — fetch/distribute DM sender keys + peer pubkey |

Every route re-validates auth via `getCurrentUser()` and asserts the caller is a participant of the conversation (the analogue of the topic membership guard, scoped to `dm_participants`). A non-participant gets `403`/`404`.

### Bot API additions (plaintext bot DMs)

- `sendMessage` gains **conversationId addressing**: the bot can target a DM conversation (where it is a participant) in addition to a topic. Plaintext only; reject if the conversation is `isE2ee` (deferred).
- A new **`dm_message` update type** is delivered to bots, carrying `conversationId`, `from` (the user principal), and plaintext `text`. Delivered via the same getUpdates/webhook transport, but keyed on `dm_participants` instead of `topic_bots`.
- SDK (`@legends/bot-sdk`) gains a matching `on("dm_message")` handler and a DM-addressed send. Existing bots are unaffected (additive).

---

## Transport (websocket)

- New events: `DM_NEW`, `DM_EDIT`, `DM_DELETE`, `DM_READ`. New room `dm:<conversationId>`. Participants join their DM rooms on connect/open.
- Send path mirrors the existing `MESSAGE_SEND` handler but writes `dm_messages` and fans out to `dm:<id>`. Permission check is simply "caller is a participant + conversation not blocked" — no role gates.
- Bot delivery: when a `dm_message` lands in a conversation with a bot participant, enqueue a bot update (and fire the webhook) — a DM analogue of the existing topic→bot producer in `apps/ws`, keyed on `dm_participants`.
- Redis fan-out mirrors the existing pattern (web app publishes; `apps/ws` relays to rooms). Separate channels from `MESSAGE_*`.

---

## Client / UI

- **Sidebar:** Topics shown by default; add a **"Direct Messages"** tab (user DM list + a Requests bucket + a "new message" search box) and a **"Bots"** tab (browse `dmEnabled` bots + open/continue bot DMs).
- **DM thread:** a dedicated component, **not** `TopicView` (which is chat/topic-specific and large). Plaintext threads are simple send/receive. E2EE threads layer in `E2EESetup` (key generation on first E2EE DM) and `E2EEKeyWarning` (TOFU), reusing `lib/e2ee.ts`.
- **Push notifications:** plaintext DM → notification shows the message text; E2EE DM → generic "New message" (server cannot read content). The push builder branches on `conversation.isE2ee`.
- Unread badges use `dm_participants.lastReadMessageId`.

---

## Files changed

### New — schema / packages
| File | Purpose |
|---|---|
| `packages/db/src/schema.ts` | add `dm_conversations`, `dm_participants`, `dm_messages`, `dm_sender_keys`, `dm_blocks`; add `bots.dmEnabled`; new pgEnums |
| `packages/db` migration | additive migration (new tables + one column) |
| `packages/shared/src/events.ts` | add `DM_*` ws events + redis channels |
| `packages/bot-sdk/src/{bot,client,types}.ts` | `dm_message` update type, `on("dm_message")`, DM-addressed send |

### New — web app
| File | Purpose |
|---|---|
| `apps/web/app/api/dm/search/route.ts` | rate-limited search |
| `apps/web/app/api/dm/route.ts` | POST open / GET list |
| `apps/web/app/api/dm/[id]/messages/route.ts` | history + send |
| `apps/web/app/api/dm/[id]/{accept,block,read}/route.ts` | lifecycle |
| `apps/web/app/api/dm/[id]/keys/route.ts` | E2EE key distribution (DM-local) |
| `apps/web/components/DmList.tsx`, `DmThread.tsx`, `DmComposer.tsx`, `NewDmSearch.tsx` | client UI |
| `apps/web/app/dm/...` or sidebar tab integration | routing/tabs |

### Modified
| File | Change |
|---|---|
| `apps/web/components/AppSidebar.tsx` | add "Direct Messages" + "Bots" tabs |
| `apps/ws/src/index.ts` + producer | DM send handler, `dm:<id>` rooms, `DM_*` events, bot DM delivery keyed on `dm_participants` |
| `apps/web/app/api/bot/v1/sendMessage/route.ts` | accept conversationId addressing (plaintext DM); reject E2EE DM |
| push builder | branch plaintext vs E2EE preview |

### Untouched (by design)
`topics`, `messages`, `topicMembers`, `topicBots`, `e2eeSenderKeys`, `TopicView`, group-E2EE distribute routes. `userKeyBundles` and `lib/e2ee.ts` are **read/reused** (shared identity + primitives) but not modified in a way that affects group E2EE.

---

## Side effects & risks

| Area | Risk / mitigation |
|---|---|
| **Open user directory** | `/api/dm/search` exposes the member list to enumeration/spam — a privacy posture change. Mitigations: rate-limit, request/accept gate, block list. Conscious sign-off given. |
| **Participant guards** | Every DM route + ws join must assert `dm_participants` membership, or a guessed `conversationId` leaks a private thread. Centralize the check. |
| **Push goes E2EE-blind** | E2EE DM previews must be generic; only plaintext DMs show content. Branch in the push builder. |
| **Bot key loss** | N/A this phase — plaintext bots have no keys. (Returns when E2EE bot DMs are designed.) |
| **Migration** | Additive only (new tables + one column). Low risk; no backfill of existing data. |
| **Multi-device** | Inherited limitation: one registered pubkey per user; a new device cannot read old E2EE DM history without passkey-PRF restore. Known, not solved here. |
| **Anon users** | Anonymous users get browser-only keys (no passkey backup); E2EE DM access is lost on session loss. Acceptable per inherited model. |

---

## Error handling

| Scenario | Behavior |
|---|---|
| Open DM to a user who blocked you | Return existing thread `blocked`; sends rejected with a clear error |
| E2EE requested but peer has no keys | Conversation created E2EE; messages queue until peer completes `E2EESetup` on accept, then sender key distributes |
| Search rate limit exceeded | `429` with retry hint |
| Non-participant hits a DM route / ws room | `403`/`404`; ws join refused |
| Bot send to an E2EE DM | Rejected (E2EE bot DMs deferred) |
| Sender-key distribution fails (network) | Send fails with existing error handling; retry on next send |

---

## Testing

- Unit: `dmKey` derivation/sorting (idempotent open for both orderings of a pair); at-rest encode/decode of `dm_messages`; E2EE envelope round-trip via `lib/e2ee.ts` for a 2-user conversation.
- Integration: open → pending → accept → exchange messages (plaintext); block prevents sends; idempotent `POST /api/dm`; participant guard rejects non-participants; bot plaintext DM round-trip (user→bot update delivered, bot→user reply fanned out).
- E2E (Playwright): new-message search → open DM → send/receive in both plaintext and opt-in E2EE; Requests bucket accept flow; sidebar Direct Messages + Bots tabs.
