-- Bot E2EE: dedicated bot_* crypto tables + e2ee state machine on bots.
-- Bots run their own Olm device; the server stores only public material and
-- relays opaque envelopes via bot_to_device_queue. Idempotency for bot-side
-- sendToDevice lives in bot_crypto_sent_txns (sender_bot_id + txn_id).

BEGIN;

-- 1) State machine + nullable pointer to the bot's active device.
ALTER TABLE "bots"
  ADD COLUMN "e2ee_state" text NOT NULL DEFAULT 'disabled',
  ADD COLUMN "e2ee_device_id" text;
ALTER TABLE "bots"
  ADD CONSTRAINT "bots_e2ee_state_chk"
    CHECK ("e2ee_state" IN ('disabled','pending','ready'));

-- 2) bot_devices: one row per bot device (currently always one per bot).
CREATE TABLE "bot_devices" (
  "bot_id"        uuid NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "device_id"     text NOT NULL,
  "algorithms"    text[] NOT NULL,
  "identity_keys" jsonb NOT NULL,
  "signatures"    jsonb,
  "unsigned"      jsonb,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("bot_id", "device_id")
);
CREATE INDEX "bot_devices_bot_id_idx" ON "bot_devices" ("bot_id");

-- 3) bot_one_time_keys: per-(bot, device, key_id) OTK pool.
CREATE TABLE "bot_one_time_keys" (
  "bot_id"     uuid NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "device_id"  text NOT NULL,
  "key_id"     text NOT NULL,
  "algorithm"  text NOT NULL,
  "key_json"   jsonb NOT NULL,
  "claimed_at" timestamptz,
  PRIMARY KEY ("bot_id", "device_id", "key_id")
);
CREATE INDEX "bot_one_time_keys_unclaimed_idx"
  ON "bot_one_time_keys" ("bot_id", "device_id")
  WHERE "claimed_at" IS NULL;

-- 4) bot_to_device_queue: mirror of user_to_device_queue; sender XOR check.
CREATE TABLE "bot_to_device_queue" (
  "id"             bigserial PRIMARY KEY,
  "bot_id"         uuid NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "device_id"      text NOT NULL,
  "event_type"     text NOT NULL,
  "sender_user_id" uuid,
  "sender_bot_id"  uuid,
  "payload"        jsonb NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CHECK (
    ("sender_user_id" IS NOT NULL AND "sender_bot_id" IS NULL) OR
    ("sender_user_id" IS NULL AND "sender_bot_id" IS NOT NULL)
  )
);
CREATE INDEX "bot_to_device_queue_bot_idx" ON "bot_to_device_queue" ("bot_id", "id");

-- 5) bot_crypto_sent_txns: idempotency for bot-side sendToDevice.
CREATE TABLE "bot_crypto_sent_txns" (
  "bot_id"     uuid NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "txn_id"     text NOT NULL,
  "event_type" text NOT NULL,
  "body_hash"  bytea NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("bot_id", "txn_id")
);

COMMIT;
