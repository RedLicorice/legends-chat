-- invite_codes: drop single-use columns, add role/usesCount/maxUses
ALTER TABLE "invite_codes" DROP COLUMN IF EXISTS "used_by_user_id";--> statement-breakpoint
ALTER TABLE "invite_codes" DROP COLUMN IF EXISTS "used_at";--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "role" "user_role" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "max_uses" integer;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "uses_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- users: track who invited whom
ALTER TABLE "users" ADD COLUMN "invited_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by_code_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_invited_by_idx" ON "users" USING btree ("invited_by_user_id");
