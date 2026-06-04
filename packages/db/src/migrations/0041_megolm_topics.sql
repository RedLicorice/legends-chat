-- Megolm E2EE for topics: enable Matrix Megolm group-session encryption on
-- topic messages, mirroring the Olm-based DM shape introduced in 0038.
--
-- The legacy `e2ee_sender_keys` table (a hand-rolled per-recipient sender-key
-- distribution scheme) is dropped in favor of OlmMachine-managed Megolm
-- sessions distributed through `user_to_device_queue` (from 0038). Existing
-- E2EE topic messages stored as plaintext-via-envelope are wiped — they
-- predate the new envelope shape and there are no real users yet.
--
-- The topic-message ciphertext column lives on `messages` (the only "topic
-- messages" table in this schema; there is no separate `topic_messages`).
-- The XOR CHECK mirrors `dm_messages_payload_chk` from 0038 verbatim.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- 1) Delete existing E2EE topic messages (they don't fit the new envelope)
-- ──────────────────────────────────────────────────────────────────────────
DELETE FROM "messages"
 WHERE "topic_id" IN (SELECT "id" FROM "topics" WHERE "is_e2ee" = true);

-- ──────────────────────────────────────────────────────────────────────────
-- 2) messages: optional Matrix m.room.encrypted envelope (Megolm)
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE "messages"
  ADD COLUMN "ciphertext_json" jsonb;

-- Plaintext rows keep using content_ciphertext (server-side envelope-encrypted
-- plaintext) with ciphertext_json IS NULL. E2EE Megolm rows store the
-- m.room.encrypted envelope in ciphertext_json and leave content_ciphertext
-- as an empty bytea (the column is NOT NULL and we don't relax that). Exactly
-- one payload form per row — same XOR shape as dm_messages_payload_chk.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_payload_chk"
    CHECK (("ciphertext_json" IS NOT NULL) <> (octet_length("content_ciphertext") > 0));

-- ──────────────────────────────────────────────────────────────────────────
-- 3) topics: synthetic Matrix room id + history-visibility invariant
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE "topics"
  ADD COLUMN "e2ee_room_id" text;

CREATE UNIQUE INDEX "topics_e2ee_room_id_idx"
  ON "topics" ("e2ee_room_id")
  WHERE "e2ee_room_id" IS NOT NULL;

-- Backfill synthetic Matrix room id for existing E2EE topics.
-- Format: "!<topicId>:legends.local" (same shape as dm_conversations).
UPDATE "topics"
   SET "e2ee_room_id" = '!' || "id"::text || ':legends.local'
 WHERE "is_e2ee" = true
   AND "e2ee_room_id" IS NULL;

-- Force history-not-visible-to-new-members on existing E2EE topics. Megolm
-- group sessions are bound to current membership; back-filling old keys to
-- new joiners isn't supported by this implementation.
UPDATE "topics"
   SET "history_visible_to_new_members" = false
 WHERE "is_e2ee" = true
   AND "history_visible_to_new_members" = true;

-- Future-proof: forbid the (e2ee=true, history-visible=true) combination.
ALTER TABLE "topics"
  ADD CONSTRAINT "topics_e2ee_history_chk"
    CHECK (NOT ("is_e2ee" = true AND "history_visible_to_new_members" = true));

-- ──────────────────────────────────────────────────────────────────────────
-- 4) user_device_change_log: append-only audit of crypto-relevant changes
-- ──────────────────────────────────────────────────────────────────────────
-- Drives OlmMachine.receive_sync_changes invalidation. `reason` is plain
-- text (not an enum) to keep room for future causes; current values are
-- 'keys_upload' | 'topic_join' | 'topic_leave' | 'admin_grant' | 'admin_revoke'.

CREATE TABLE "user_device_change_log" (
  "id"         bigserial PRIMARY KEY,
  "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "reason"     text NOT NULL,
  "changed_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "user_device_change_log_user_idx"
  ON "user_device_change_log" ("user_id", "changed_at");

CREATE INDEX "user_device_change_log_cursor_idx"
  ON "user_device_change_log" ("changed_at");

-- ──────────────────────────────────────────────────────────────────────────
-- 5) Drop legacy sender-key distribution table
-- ──────────────────────────────────────────────────────────────────────────
-- Replaced by OlmMachine-managed Megolm sessions distributed through the
-- user_to_device_queue (0038).
DROP TABLE IF EXISTS "e2ee_sender_keys";

-- ──────────────────────────────────────────────────────────────────────────
-- 6) Purge legacy-topic placeholder key bundles
-- ──────────────────────────────────────────────────────────────────────────
-- The 'legacy-topic' device_id was a synthetic bundle for the old sender-key
-- scheme. Megolm uses real per-device bundles created by OlmMachine.
DELETE FROM "user_key_bundles" WHERE "device_id" = 'legacy-topic';

COMMIT;
