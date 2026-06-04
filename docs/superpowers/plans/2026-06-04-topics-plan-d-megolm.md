# Plan D — Topic (Group) E2EE via Megolm

Date: 2026-06-04
Status: Design — pre-implementation
Supersedes: legacy sender-key E2EE in `packages/crypto` + `apps/web/app/api/topics/[id]/e2ee/*` + `apps/web/components/E2EESetup.tsx`
Builds on: Plan B' (`be0f530`) — 1:1 DM E2EE via `matrix-sdk-crypto-wasm` (`OlmMachine`)

## Context

Plan B' shipped 1:1 DM E2EE using `matrix-sdk-crypto-wasm`'s `OlmMachine` wrapped at `apps/web/lib/dm-crypto.ts`, with Matrix-CS-shape endpoints under `/api/crypto/*` for key upload, query, claim, sendToDevice, and sync.

Plan D extends that same `OlmMachine` to support topic (multi-user) E2EE using Megolm sessions. The Olm + Megolm primitives are already present in the wrapper — the work here is:

1. Generalize the wrapper from "DM with peer list of 2" to "room with N members".
2. Wire topic membership changes to Megolm key rotation.
3. Add a `device_lists.changed` feed to `/api/crypto/sync` so member-set changes propagate.
4. Rip out the legacy sender-key implementation.

## User decisions (locked)

1. **`history_visible_to_new_members`**: force `false` on E2EE topics. Surface as banner "history not retained for new members".
2. **Existing E2EE topic data**: HARD DELETE encrypted `topic_messages` rows during migration.
3. **Wrapper rename**: rename `apps/web/lib/dm-crypto.ts` → `apps/web/lib/crypto.ts` cleanly; update all import paths; no back-compat aliases.
4. **Megolm rotation policy**: Matrix defaults (1 week / 100 messages).
5. **`device_lists.changed` source**: log-table `user_device_change_log`.
6. **Admin key recipient**: yes. All site admins (`users.role='admin'`) are auto-added as recipients on every E2EE topic's room key. UI banner notifies users which admins can decrypt.

## What Plan B' shipped that Plan D reuses

- `OlmMachine` wrapper at `apps/web/lib/dm-crypto.ts` — handles Olm + Megolm primitives.
- `/api/crypto/{keys/upload,query,claim,sendToDevice,sync}` — Matrix-CS-shape endpoints; no changes needed except `/sync` extension to populate `device_lists.changed`.
- Schema: `user_key_bundles` (per-device), `user_one_time_prekeys`, `user_to_device_queue`, `crypto_sent_txns`.
- WS_EVENTS + Redis channels for crypto.

## Plan D scope

### Wrapper API (`apps/web/lib/crypto.ts`)

Rename `apps/web/lib/dm-crypto.ts` → `apps/web/lib/crypto.ts` and extend. Public API after rename:

```ts
// DM 1:1 (kept; thin wrappers around room ops with a fixed peer list)
encryptDm(roomId, plaintext): EncryptedEnvelope
decryptDm(roomId, envelope: IncomingEnvelope): string

// Group room (new)
encryptRoom(roomId, plaintext): EncryptedEnvelope
decryptRoom(roomId, envelope: IncomingEnvelope): string

ensureRoomMembers(roomId, userIds: string[]): Promise<void>
  // calls updateTrackedUsers + shareRoomKey + pumpOutgoing for full member set

onMembershipChange(roomId, action: "join" | "leave", userId: string): Promise<void>
  // call OlmMachine.discardRoomKey(roomId) then ensureRoomMembers with new set

getRoomFingerprint(roomId): string | null
  // hash of sorted member ed25519 keys for a visible "safety code"
```

Internally `encryptDm` becomes `encryptRoom` with 2 members. The DM-specific entry points stay as named wrappers to keep call sites readable, but the implementation is unified.

Rotation policy delegated to `OlmMachine` defaults (rotate after 1 week or 100 messages), which matches Matrix client defaults. No configuration override.

### Schema migration `packages/db/src/migrations/0041_megolm_topics.sql`

```sql
BEGIN;

-- 1. Topic-level E2EE room mapping
ALTER TABLE topics ADD COLUMN IF NOT EXISTS e2ee_room_id text;
CREATE UNIQUE INDEX IF NOT EXISTS topics_e2ee_room_id_idx
  ON topics (e2ee_room_id) WHERE e2ee_room_id IS NOT NULL;

-- 2. Encrypted message envelope on topic_messages, XOR with existing plaintext column
ALTER TABLE topic_messages ADD COLUMN IF NOT EXISTS ciphertext_json jsonb;
-- (Existing payload column name TBD — read schema.ts to confirm; mirror dm_messages CHECK pattern)
ALTER TABLE topic_messages ADD CONSTRAINT topic_messages_payload_chk
  CHECK ((ciphertext_json IS NOT NULL) <> (octet_length(<plaintext_col>) > 0));

-- 3. Device-change log feeds /api/crypto/sync device_lists.changed
CREATE TABLE user_device_change_log (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL,  -- 'keys_upload', 'topic_join', 'topic_leave', 'admin_grant', 'admin_revoke'
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_device_change_log_user_idx
  ON user_device_change_log (user_id, changed_at);
CREATE INDEX user_device_change_log_cursor_idx
  ON user_device_change_log (changed_at);

-- 4. Hard-delete existing E2EE topic encrypted messages
DELETE FROM topic_messages
  WHERE topic_id IN (SELECT id FROM topics WHERE is_e2ee = true);

-- 5. Drop sender-key legacy table
DROP TABLE IF EXISTS e2ee_sender_keys;

-- 6. Drop legacy-topic device slot in user_key_bundles
DELETE FROM user_key_bundles WHERE device_id = 'legacy-topic';

-- 7. Force history_visible_to_new_members=false on existing E2EE topics
UPDATE topics SET history_visible_to_new_members = false WHERE is_e2ee = true;

-- 8. Backfill e2ee_room_id for existing E2EE topics
UPDATE topics
  SET e2ee_room_id = '!' || id::text || ':legends.local'
  WHERE is_e2ee = true AND e2ee_room_id IS NULL;

COMMIT;
```

Journal entry: `idx 41, when 1780100000000, tag "0041_megolm_topics"`.

### Server endpoints

#### `GET /api/crypto/rooms/[roomId]/members`

- Parse `roomId` → `topicId` (or `dmConvId` — supports both shapes).
- For topics: members = `topic_members.user_id WHERE topic_id = $topicId`, plus ALL users `WHERE role = 'admin'` (deduped), excluding bots.
- For DM rooms: members = `dm_participants` (existing behavior).
- Response shape:

```json
{
  "user_ids": ["<userId>", "..."],
  "admin_user_ids": ["<userId>", "..."]
}
```

`admin_user_ids` lets the client render the admin recipient banner with names.

#### Extend `POST /api/topics/[id]/messages`

- Accept `ciphertext_json` XOR the existing plaintext field. Mirror the `dm_messages` route pattern from Plan B'.
- If `topic.is_e2ee`: require `ciphertext_json`; reject plaintext.
- If `!topic.is_e2ee`: require plaintext; reject `ciphertext_json`.
- Same XOR enforced by the DB CHECK constraint added in migration 0041.

#### Extend `GET /api/crypto/sync`

- Populate `device_lists.changed` from `user_device_change_log` rows since the `since` cursor.
- Distinct `user_id`s ordered by `changed_at`; cap 200 per sync.
- Cursor advance: `max(changed_at_seen, max(queue_row.created_at_seen))`.

### Topic message path

**Send (client):**

1. Ensure crypto session initialized (`initCrypto` + `bootstrap` if not).
2. `GET /api/crypto/rooms/${e2eeRoomId}/members` → `memberUserIds` + `adminUserIds`.
3. `ensureRoomMembers(roomId, memberUserIds ∪ adminUserIds)` → triggers `/keys/query` + `shareRoomKey` + to-device fan-out via `pumpOutgoing`.
4. `encryptRoom(roomId, plaintext)` → envelope.
5. `POST /api/topics/[id]/messages` with `{ ciphertext_json: envelope }`.

**Receive (client):**

1. `pollSync` drains to-device room keys.
2. Topic socket pushes ciphertext.
3. `decryptRoom(roomId, envelope)` → plaintext.

### Membership delta wiring

When `topic_members` insert/delete fires:

- Write `user_device_change_log` rows for ALL existing members (so each member's client gets a `device_lists.changed` containing the affected user) AND for the joining/leaving user.
- Simpler alt that we adopt: just one row for the affected user; every other member triggers `/keys/query` on next sync since their tracker sees the row. `OlmMachine` handles re-share automatically. We rely on the simpler form unless field testing shows a missed re-share.

When `users.role` flips to/from `admin`:

- Write `user_device_change_log` row for that user with `reason = 'admin_grant'` or `'admin_revoke'`.
- All E2EE topic members observe this via sync and re-share keys to include/exclude the admin on next outgoing message.

When `user_key_bundles` upserts (device added/refreshed):

- Log row for that user, `reason = 'keys_upload'`.

### TopicLayout wiring

- E2EE topic detection: pre-fetched from server (`topic.is_e2ee`).
- Setup gate: if crypto not initialized, prompt "Initialize encryption" (same UX as DM in Plan B').
- Banner (mandatory, non-dismissible): "🔒 End-to-end encrypted. Visible to admins: <names>. New members will NOT see prior messages." Computed from `admin_user_ids` returned by `/api/crypto/rooms/[roomId]/members`.
- Send/receive paths replace existing `TopicView` message handlers.
- Membership change observation: subscribe to topic socket `topic:member:joined` / `topic:member:left` → call `onMembershipChange(roomId, action, userId)`.

### Bot E2EE in topics

- Bots cannot participate in E2EE topics.
- Server-side guard on `topic_members` insert: reject when `topic.is_e2ee = true` AND `member.principal_type = 'bot'` with HTTP 4xx + message "bots cannot join encrypted topics".

### Cleanup

Files to delete:

- `apps/web/app/api/topics/[id]/e2ee/route.ts`
- `apps/web/app/api/topics/[id]/e2ee/distribute/route.ts`
- `apps/web/components/E2EESetup.tsx`
- `apps/web/components/E2EEKeyWarning.tsx`
- `packages/crypto/` sender-key-specific files. Keep the data-key / wrap / unwrap server-side helpers used by plaintext DM at-rest encryption — those are unrelated to the Megolm path.
- `apps/web/app/api/user/keys/route.ts` (legacy backup slot). Nothing else uses it after `E2EESetup` deletion.

Schema changes baked into cleanup:

- `e2ee_sender_keys` table drop (in migration 0041, step 5).
- `user_key_bundles.signed_prekey_*` columns from migration 0037 — already nullable; can drop in a follow-up migration. Not required for Plan D.

### Admin key recipient model (security note)

Trust boundary changes from "only room members" to "room members + site admins".

Each E2EE topic message is decryptable by:

- Sender + all room members at send time.
- All site admins at send time, because admin Olm devices receive the Megolm room key via to-device.

Admin set changes via role flip → `user_device_change_log` → next sender's `outgoingRequests` re-shares to the new admin set going forward.

Past messages are **NOT** retroactively decryptable by new admins (forward-only — they never received the Megolm session for those messages).

UI must be loud about this. Banner is mandatory on every E2EE topic, always visible, not dismissible. Same banner appears in the topic create modal so opt-in is informed.

### Open Qs (default decisions, redirect if wrong)

- **Multi-tab on E2EE topic**: same constraint as DM — `OlmMachine` IndexedDB store is single-writer. Leader-tab pattern or banner-and-refuse. Defer to a follow-up; document the limitation.
- **Mobile cold-load**: 3 MB WASM, lazy import. Same as DM in Plan B'.
- **Megolm key backup** (server-side encrypted blob for offline device recovery): NOT in scope. Lose device = lose history. Documented.

### Test plan

3 user accounts (A, B, C) + 1 site admin (Z, `role = 'admin'`). Test cases:

1. **Create E2EE topic** as A. C and Z are added as members (C explicit, Z auto via admin role). B is not a member.
2. **A initializes crypto, sends a message.** A, C, and Z all see plaintext on render. DB storage holds ciphertext only.
3. **B added to topic.** B sees the new-history banner. B's prior-to-join messages remain locked (forward-only). B sees new messages from A / C / Z.
4. **B leaves.** A sends new message → B cannot decrypt going forward (key rotated, B excluded).
5. **Z admin role revoked.** A sends new message → Z cannot decrypt going forward.
6. **Admin banner visible always.** Lists Z by displayName.
7. **Mobile single-pane**: same flow at 375x812.
8. **Negative — bot membership**: trying to add a bot to an E2EE topic returns 4xx with "bots cannot join encrypted topics".
9. **DB verification**: `SELECT` confirms `ciphertext_json` populated and the plaintext column empty for E2EE topic messages.

### Task breakdown (subagent-driven, parallelized, commit at end only)

1. (this doc)
2. Migration 0041
3. Rename wrapper + room ops
4. Server endpoints (`rooms/[roomId]/members` + topic msg ciphertext + `/sync` `device_lists.changed`)
5. TopicLayout wiring + admin recipient banner
6. Cleanup legacy sender-key code
7. Live 3-user + admin test
8. Single end commit

### Risks

- **Large topic + many admins**: each Megolm rotation = N × D to-device messages. For a 100-member topic × 2 devices × 3 admins × 2 devices = 412 to-device sends per rotation. Rotation triggers on every membership change. Mitigate by batching to-device queue inserts; verify performance during the live test.
- **Admin device proliferation**: admins log in across multiple devices. Each admin device is added to the recipient set. Risk of partial decrypt if some admin devices fall behind `/sync` — they will simply miss messages they were offline for. Acceptable.
- **`history_visible_to_new_members` UX collision**: was a user-facing toggle; forcing `false` on E2EE topics means it becomes a derived field. Topic edit UI must hide or disable the toggle when `is_e2ee = true`.
