-- Drop the wrong-shape unique index on user_to_device_queue.
-- The index (sender_user_id, sender_device_id, txn_id) treats txn_id as a
-- per-row idempotency key, but a single Matrix sendToDevice request fans out
-- to N (recipient, device) rows that all share the same txn_id. The first
-- insert succeeds; all subsequent recipients hit a uniqueness violation and
-- their rows are silently lost — breaking room-key fan-out to ≥2 recipients.
--
-- Per-request idempotency is already tracked by `crypto_sent_txns` (migration
-- 0039), which is the correct shape ("did we already apply this whole txn?").
-- This index is redundant + harmful, so drop it.

BEGIN;
DROP INDEX IF EXISTS user_to_device_queue_txn_idx;
COMMIT;
