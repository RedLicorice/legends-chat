# Changelog — 2026-06-11

## End-to-End Encryption (Topic Channels)

Megolm topic channels via `@matrix-org/matrix-sdk-crypto-wasm`, the live
member-change rotation path, encrypted edits, and the locked-message UX
that replaced the bare "(encrypted)" placeholder. Covers commits between
2026-06-04 and 2026-06-09.

The crypto primitive is **Matrix Megolm via `matrix-sdk-crypto-wasm`**
(vodozemac through wasm-bindgen, NCC-audited). Not Signal. Not a
hand-rolled sender-key invention. Sender keys are distributed per
recipient via Olm sessions; the community admin is always a recipient so
moderation remains possible — see threat-model note below.

### E2EE topic channels (Plan D)

`035c38c` retires the legacy sender-key topic E2EE and replaces it with
Megolm sessions on the same `OlmMachine` Plan B' added for DMs. One
crypto stack now serves both DM and topic E2EE.

- **Wrapper rename and group ops**
  (`apps/web/lib/dm-crypto.ts` → `apps/web/lib/crypto.ts`).
  - Adds `encryptRoom`, `decryptRoom`, `ensureRoomMembers`,
    `onMembershipChange`, `getRoomFingerprint`.
  - Exports Megolm rotation defaults: 1 week / 100 messages.
  - Single-flight mutex on `pumpOutgoing` so concurrent callers cannot
    replay the same `KeysQuery` from racing pump cycles. `OlmMachine`
    is not concurrent-safe; this is load-bearing.
  - `ensureRoomMembers` / `ensureRoomMembersPeers` reduced from three
    serial pump calls to one final drain.
- **Schema** (`packages/db/src/migrations/0041_megolm_topics.sql` and
  `0042_user_to_device_queue_drop_txn_idx.sql`):
  - `topics.e2ee_room_id` with unique partial index.
  - `topics_e2ee_history_chk` CHECK forces
    `history_visible_to_new_members=false` on E2EE topics. New
    members see forward-only because Megolm sessions are sender-pinned
    and don't replay prior keys.
  - `messages.ciphertext_json jsonb` + `messages_payload_chk` XOR with
    `octet_length(content_ciphertext)`.
  - `user_device_change_log` table feeds `device_lists.changed` in
    `/api/crypto/sync`; reasons are `keys_upload`, `topic_join`,
    `admin_grant`, `admin_revoke`.
  - **Hard delete** of prior E2EE topic messages (the old sender-key
    scheme is gone; nothing in the database is still readable through
    it). Drops the legacy `e2ee_sender_keys` table; drops
    `legacy-topic` rows from `user_key_bundles`.
  - Drops `user_to_device_queue_txn_idx` — the
    `(sender, sender_dev, txn_id)` unique broke multi-recipient
    fan-out. Idempotency stays on `crypto_sent_txns` from migration
    0039.
- **Server endpoints**
  - `GET /api/crypto/rooms/[roomId]/members`
    (`apps/web/app/api/crypto/rooms/[roomId]/members/route.ts`) returns
    `user_ids`, `member_user_ids`, `admin_user_ids`. Admins are INNER
    JOINed against `user_key_bundles` so an admin who has never booted
    crypto on a device never stalls `ensureRoomMembers`.
  - `POST /api/topics/[id]/messages` (via `apps/ws/src/messages.ts`)
    accepts `ciphertext_json` XOR `text`, branching on `topic.is_e2ee`.
  - `GET /api/crypto/sync` drains `user_device_change_log` alongside
    the to-device queue. Both cursors round-trip through
    millisecond-truncated ISO timestamps via
    `date_trunc('milliseconds', …) > $since` plus `DISTINCT ON
    user_id` so `matrix-sdk-crypto` doesn't re-query the same users
    forever.
  - `logDeviceChange` hooks wired in `apps/web/app/api/crypto/keys/upload/route.ts`,
    the admin user-role flip path, and `ws ensureTopicMembership`
    (topic join).
  - Admin topic create/update forces
    `history_visible_to_new_members=false` when E2EE. Bot membership
    rejected for E2EE topics at the same site — bots don't run the
    Matrix client.
- **Admin recipient is permanent.** The members endpoint returns
  `admin_user_ids` separately so the client can render a
  non-dismissible banner listing the moderator names that can decrypt.
  This is by design — the threat model is "private from the public
  internet, not private from your community moderator." Sender-key
  rotation cannot exclude admins; doing so would require splitting the
  trust model into two encrypted-streams per topic, which is out of
  scope.
- **Client wiring** (`apps/web/components/TopicView.tsx` at the time of
  the commit; the same file becomes `ChatPane.tsx` after the unified
  refactor):
  - Old sender-key setup gate replaced by the Megolm bootstrap gate.
  - Mandatory non-dismissible admin recipient banner; admin display
    names resolve via per-id fetch with a sliced-uuid fallback when
    the user row isn't loaded yet.
  - Send path:
    `refreshRoomMembers → ensureRoomMembers → encryptRoom → POST
    envelope`. Self-healing rotation on membership delta runs at send
    time because no live member-change socket exists yet — that lands
    in `e8f8da9`, below.
  - Receive: 5-second `pollSync` gated by Page Visibility; retry
    decrypt of locked rows on each tick; lock placeholder until the
    room key lands.
- **Cleanup** (-951 LoC):
  `apps/web/app/api/topics/[id]/e2ee/route.ts`,
  `apps/web/app/api/topics/[id]/e2ee/distribute/route.ts`,
  `apps/web/app/api/user/keys/route.ts`,
  `apps/web/components/E2EESetup.tsx`,
  `apps/web/components/E2EEKeyWarning.tsx`,
  `apps/web/lib/e2ee.ts` all deleted. `packages/crypto` is kept — it
  still hosts the data-key wrap/unwrap helpers used for plaintext
  at-rest encryption everywhere else.

### Member-change handling

`e8f8da9` wires the live rotation socket so a new join doesn't have to
wait for the next send to trigger key rotation.

- `packages/shared/src/events.ts:25/:79` — adds
  `WS_EVENTS.TOPIC_MEMBERS_UPDATED` and the matching
  `REDIS_CHANNELS.TOPIC_MEMBERS_UPDATED`
  (`legends:topic:members:updated`).
- `apps/ws/src/index.ts` publishes after the first `topic_members`
  insert, gated on `inserted.length > 0`. The query is reproduced
  inline in `apps/ws/` — the ws app cannot import `@/lib`.
- `apps/web/lib/topic-members.ts` (`listTopicCryptoMembers`) — admins
  INNER-JOINed against `userKeyBundles` so unbooted admins don't show
  up in the rotation set.
- `apps/web/lib/topic-events.ts` (`publishTopicMembersUpdated`).
- Web subscribes inside the topic view and calls
  `crypto.onMembershipChange(roomId, newMembers)`, which invalidates
  the current group session so the next `encryptRoom` rotates.

### E2EE preview UX

Same commit (`e8f8da9`). The bare "(encrypted)" preview string in the
sidebar leaked nothing useful and looked broken.

- E2EE topics render the description italic-muted; E2EE DMs render an
  empty preview slot. Non-E2EE rows unchanged.
- `apps/web/components/ChatListItem.tsx` gains a `PreviewSlot`
  subcomponent; `apps/web/lib/chat-list.ts` `ChatItem` carries an
  optional `description` field; `TopicListItem` falls through an empty
  preview to the description; `ChatListPane` null-coerces preview on
  `SIDEBAR_UPDATE` / `DM_NEW`.

### Encrypted edit path

Same commit (`e8f8da9`). Editing an E2EE message was previously a no-op
because the schema only stored ciphertext, never plaintext to diff
against.

- `apps/web/lib/zod/messages.ts` `messageEditSchema` XOR on `text` vs
  `ciphertextJson` (`superRefine`).
- `apps/ws/src/messages.ts editMessage` accepts
  `{newText?, newCiphertextJson?}`; the `MESSAGE_EDIT_REQ` handler
  branches on `topic.isE2ee` and rejects a mismatched payload (E2EE
  topic with `text`, plain topic with `ciphertextJson`). Broadcast row
  carries `ciphertextJson` so clients can re-decrypt.
- `TopicView.submitEdit` E2EE branch:
  `refreshRoomMembers → ensureRoomMembers → encryptRoom → emit with
  ciphertextJson`. On `MESSAGE_EDIT` receive, the client clears
  `decryptedTexts[id]` so the new ciphertext is decrypted fresh — the
  old plaintext was just stale.

### Locked-message UX (blur, lock pill, no interactions)

`5cc07ec` replaces the bare "(encrypted...)" string with a blurred
deterministic placeholder + a lock button that opens a "why is this
locked?" modal.

- **`apps/web/components/EncryptedMessageContent.tsx`** renders a
  Tailwind-blurred span whose width and shape are sized by a
  djb2-seeded `mulberry32` PRNG (lines 23-45) keyed off `messageId`. The
  same id always renders the same shape; no flicker on re-render. The
  placeholder approximates the look of a real bubble so the reader's
  eye doesn't lose its place when keys arrive and the rows resolve.
- **`apps/web/components/EncryptedReasonModal.tsx`** exposes a
  discriminated `EncryptedReason` union with copy per case:
  - `setup-required` — viewer hasn't run E2EE setup yet on this device.
  - `initializing` — `OlmMachine` is still bootstrapping.
  - `bootstrap-failed` — `OlmMachine` failed; reload likely needed.
  - `missing-key` — sender's Megolm session key has not arrived
    (`MissingRoomKey` + `withheld_code = None`).
  - `predates-room-key` — viewer joined after this message was
    encrypted; Megolm doesn't replay prior keys
    (`UnknownMessageIndex`).
  - `withheld` — sender explicitly declined to share the key
    (`MissingRoomKey` + non-`None` `withheld_code`).
  - `decrypt-error` — anything else.
- **`apps/web/components/ChatPane.tsx`** captures errors from both
  decrypt drain loops into a `decryptErrors` map (cleared on later
  success). `describeDecryptError` reads the `matrix-sdk-crypto`
  `MegolmDecryptionError` `code` + `description` getters **directly**
  — the wasm-bindgen proxy object isn't JSON-serializable (it
  stringifies to `{"__wbg_ptr":N}` if you try to spread it).
- `DECRYPT_CODE_NAMES` table at `ChatPane.tsx:142-155` maps the
  numeric `DecryptionErrorCode` to a stable textual tag:
  - `0 → MissingRoomKey`
  - `1 → UnknownMessageIndex`
  - `2 → MismatchedIdentityKeys`
  - `3 → UnknownSenderDevice`
  - `4 → UnsignedSenderDevice`
  - `5 → SenderIdentityVerificationViolation`
  - `6 → UnableToDecrypt`
- `getEncryptedReason` maps `DecryptionErrorCode` to the union:
  `UnknownMessageIndex → predates-room-key`,
  `MissingRoomKey + non-None withheld → withheld`,
  `MissingRoomKey + None → missing-key`,
  everything else → `decrypt-error`.
- Attachment-margin and empty-bubble-padding rules updated at all
  three bubble sites so the placeholder counts as visible content for
  spacing. Thread reply preview shows "(encrypted)" for encrypted
  parents instead of slicing the blur text.

### Locked-bubble interaction guards

`99132a3`.

- `EncryptedMessageContent` now returns a `Fragment` so the lock
  button absolute-positions against the bubble's existing `relative`
  ancestor, not the placeholder span. Measured `dx=0, dy=0` in the
  browser — pill lands dead center of the bubble.
- Hover React/Reply buttons (feed and grouped variants), the feed
  "+ Comment" thread section, and the right-click / long-press context
  menu are all gated on `!isStillEncrypted(msg)` in `ChatPane.tsx`.
  Nothing on a locked bubble can fire `toggleReaction`,
  `setReplyingTo`, or `openContextMenu` now. Avoids the obvious bug
  where a user reacts to ciphertext they can't read.

### Known follow-ups (carried from `035c38c`)

- Edit on E2EE topic disabled for the unified-edit path that hasn't
  re-Megolm-encrypted (the topic edit path in `e8f8da9` covers this;
  the DM-side edit/delete/react capability set in `ChatPane` is still
  feature-flagged off — see the DMs changelog).
- Megolm message rewrite is not in scope; edits ship a fresh
  encrypted envelope.
- No per-message forward secrecy. Megolm sessions rotate on the 1
  week / 100 messages default and on membership change; within a
  session, prior messages are decryptable by anyone holding the
  current session key.
