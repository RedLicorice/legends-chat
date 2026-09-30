-- cr-l12: give DMs their own at-rest data key purpose. Existing dm_messages
-- rows keep their current key_id and keep decrypting unchanged; only NEW DM
-- ciphertext is written under the new purpose.
ALTER TYPE "encryption_purpose" ADD VALUE IF NOT EXISTS 'dm_messages';
--> statement-breakpoint
-- cr-l12: close the read-then-insert race on fresh-DB bootstrap at the DB
-- level, so a caller that bypasses the shared helper in src/data-keys.ts still
-- cannot create a second active key for a purpose. Skipped (rather than failed)
-- if an existing deployment somehow already has duplicates.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "encryption_keys"
        WHERE "rotated_at" IS NULL
        GROUP BY "purpose"
        HAVING count(*) > 1
    ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS "encryption_keys_active_purpose_idx"
            ON "encryption_keys" ("purpose") WHERE "rotated_at" IS NULL;
    END IF;
END $$;
