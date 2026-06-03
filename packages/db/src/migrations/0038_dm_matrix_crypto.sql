-- Plan B (Matrix Olm via matrix-sdk-crypto-wasm): switch from hand-rolled
-- Double Ratchet prekey shape to Matrix-shaped key bundles, OTK pool, and
-- to-device queue. Multi-device per user. Dev-only wipe of prekey state.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- 1) user_key_bundles: multi-device, Matrix key shape
-- ──────────────────────────────────────────────────────────────────────────

-- Wipe existing rows (dev only, no real users); previous PK is user_id alone
-- and we cannot re-key it in place without losing data.
DELETE FROM "user_key_bundles";

-- Drop 0037 prekey columns — OlmMachine manages prekey lifecycle internally.
ALTER TABLE "user_key_bundles"
  DROP COLUMN IF EXISTS "signed_prekey_id",
  DROP COLUMN IF EXISTS "signed_prekey",
  DROP COLUMN IF EXISTS "signed_prekey_sig",
  DROP COLUMN IF EXISTS "signed_prekey_updated_at";

-- Recompose primary key to (user_id, device_id).
ALTER TABLE "user_key_bundles" DROP CONSTRAINT "user_key_bundles_pkey";
ALTER TABLE "user_key_bundles"
  ADD COLUMN "device_id" text NOT NULL;
ALTER TABLE "user_key_bundles"
  ADD CONSTRAINT "user_key_bundles_pkey" PRIMARY KEY ("user_id", "device_id");

-- Matrix-shaped device key record.
ALTER TABLE "user_key_bundles"
  ADD COLUMN "algorithms_json"   jsonb NOT NULL,
  ADD COLUMN "keys_json"         jsonb NOT NULL,
  ADD COLUMN "signatures_json"   jsonb NOT NULL,
  ADD COLUMN "fallback_key_json" jsonb;

-- Keep existing identity_public_key + key_bundle columns as denormalized
-- compatibility surface. olm_identity_curve25519 / olm_identity_ed25519 do
-- NOT exist on this table in the current schema — keys_json is canonical.

-- ──────────────────────────────────────────────────────────────────────────
-- 2) user_one_time_prekeys: Matrix key shape, per-device
-- ──────────────────────────────────────────────────────────────────────────

-- Wipe (0037 shape doesn't match new shape).
DELETE FROM "user_one_time_prekeys";

-- Drop old PK and indexes tied to old shape.
ALTER TABLE "user_one_time_prekeys" DROP CONSTRAINT "user_one_time_prekeys_pkey";
DROP INDEX IF EXISTS "user_one_time_prekeys_pk_idx";
DROP INDEX IF EXISTS "user_one_time_prekeys_user_idx";

-- Drop unused id column (we'll PK on (user_id, device_id, key_id)).
ALTER TABLE "user_one_time_prekeys" DROP COLUMN IF EXISTS "id";

-- Drop consumed_at / consumed_by_user_id (0037 shape); we'll use used_at.
ALTER TABLE "user_one_time_prekeys" DROP COLUMN IF EXISTS "consumed_at";
ALTER TABLE "user_one_time_prekeys" DROP COLUMN IF EXISTS "consumed_by_user_id";

-- Replace prekey_id (text) → key_id (text, Matrix-style like "signed_curve25519:AAAA").
ALTER TABLE "user_one_time_prekeys" DROP COLUMN IF EXISTS "prekey_id";
ALTER TABLE "user_one_time_prekeys" ADD COLUMN "key_id" text NOT NULL;

-- Replace prekey (text) → key_json jsonb ({"key":"...","signatures":{...}}).
ALTER TABLE "user_one_time_prekeys" DROP COLUMN IF EXISTS "prekey";
ALTER TABLE "user_one_time_prekeys" ADD COLUMN "key_json" jsonb NOT NULL;

-- Add device_id, algorithm, used_at.
ALTER TABLE "user_one_time_prekeys"
  ADD COLUMN "device_id" text NOT NULL,
  ADD COLUMN "algorithm" text NOT NULL DEFAULT 'signed_curve25519',
  ADD COLUMN "used_at"   timestamp with time zone;

-- Composite PK.
ALTER TABLE "user_one_time_prekeys"
  ADD CONSTRAINT "user_one_time_prekeys_pkey"
    PRIMARY KEY ("user_id", "device_id", "key_id");

-- FK to the device bundle.
ALTER TABLE "user_one_time_prekeys"
  ADD CONSTRAINT "user_one_time_prekeys_device_fk"
    FOREIGN KEY ("user_id", "device_id")
    REFERENCES "user_key_bundles"("user_id", "device_id")
    ON DELETE CASCADE;

-- Fast unused-OTK lookup.
CREATE INDEX "user_one_time_prekeys_unused_idx"
  ON "user_one_time_prekeys" ("user_id", "device_id", "algorithm")
  WHERE "used_at" IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- 3) user_to_device_queue: Matrix-style to-device event queue
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE "user_to_device_queue" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "recipient_user_id"   uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "recipient_device_id" text NOT NULL,
  "sender_user_id"      uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "sender_device_id"    text NOT NULL,
  "event_type"          text NOT NULL,
  "content_json"        jsonb NOT NULL,
  "txn_id"              text NOT NULL,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "delivered_at"        timestamp with time zone
);

CREATE INDEX "user_to_device_queue_recipient_idx"
  ON "user_to_device_queue" ("recipient_user_id", "recipient_device_id", "created_at")
  WHERE "delivered_at" IS NULL;

CREATE UNIQUE INDEX "user_to_device_queue_txn_idx"
  ON "user_to_device_queue" ("sender_user_id", "sender_device_id", "txn_id");

-- ──────────────────────────────────────────────────────────────────────────
-- 4) dm_conversations: optional Matrix room_id when E2EE is on
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE "dm_conversations"
  ADD COLUMN "e2ee_room_id" text;

CREATE UNIQUE INDEX "dm_conversations_e2ee_room_id_idx"
  ON "dm_conversations" ("e2ee_room_id")
  WHERE "e2ee_room_id" IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- 5) dm_messages: optional ciphertext envelope (m.room.encrypted)
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE "dm_messages"
  ADD COLUMN "ciphertext_json" jsonb;

-- Plaintext rows keep using content_ciphertext (server-side envelope-encrypted
-- plaintext) and ciphertext_json IS NULL. E2EE rows store the m.room.encrypted
-- envelope in ciphertext_json and may leave content_ciphertext as an empty
-- bytea (the column is NOT NULL and we don't want to relax that for legacy
-- reads). Exactly one payload form per row.
ALTER TABLE "dm_messages"
  ADD CONSTRAINT "dm_messages_payload_chk"
    CHECK (("ciphertext_json" IS NOT NULL) <> (octet_length("content_ciphertext") > 0));

COMMIT;
