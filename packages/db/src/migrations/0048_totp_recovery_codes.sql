CREATE TABLE IF NOT EXISTS "totp_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "code_hash" text NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "totp_recovery_codes_user_idx" ON "totp_recovery_codes" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "totp_recovery_codes_lookup_idx" ON "totp_recovery_codes" ("user_id","code_hash");
