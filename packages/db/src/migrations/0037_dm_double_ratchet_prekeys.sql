-- Plan B (Double Ratchet): extend identity key bundle with signed prekey + add
-- one-time prekey pool. Server stores public material only.

ALTER TABLE "user_key_bundles"
  ADD COLUMN IF NOT EXISTS "signed_prekey_id" text,
  ADD COLUMN IF NOT EXISTS "signed_prekey" text,
  ADD COLUMN IF NOT EXISTS "signed_prekey_sig" text,
  ADD COLUMN IF NOT EXISTS "signed_prekey_updated_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "user_one_time_prekeys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "prekey_id" text NOT NULL,
  "prekey" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_one_time_prekeys_pk_idx" ON "user_one_time_prekeys" ("user_id", "prekey_id");
CREATE INDEX IF NOT EXISTS "user_one_time_prekeys_user_idx" ON "user_one_time_prekeys" ("user_id", "consumed_at");
