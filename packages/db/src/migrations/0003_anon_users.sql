ALTER TABLE "users" ALTER COLUMN "telegram_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_anon" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "anon_expires_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX "users_telegram_user_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "users_telegram_user_id_idx" ON "users" ("telegram_user_id") WHERE "telegram_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_anon_expiry_idx" ON "users" ("anon_expires_at") WHERE "is_anon" = true;
