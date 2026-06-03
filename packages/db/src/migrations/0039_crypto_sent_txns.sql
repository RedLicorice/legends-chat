-- Per-request idempotency tracking for `PUT /api/crypto/sendToDevice/:event/:txn_id`.
-- A single Matrix sendToDevice request fans out to N (recipient, device) rows
-- in user_to_device_queue, but Matrix's txn_id is per-request — so we need
-- "this txn was already applied" tracked once, not N times. The unique on
-- user_to_device_queue.(sender_user_id, sender_device_id, txn_id) collides
-- after the very first inserted recipient row, which is the wrong shape.

CREATE TABLE "crypto_sent_txns" (
  "sender_user_id"   uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "sender_device_id" text NOT NULL,
  "txn_id"           text NOT NULL,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("sender_user_id", "sender_device_id", "txn_id")
);
