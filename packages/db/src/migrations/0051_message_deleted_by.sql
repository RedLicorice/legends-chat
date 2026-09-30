-- cr-m10: message deletion had no actor anywhere. Every delete path wrote only
-- `deleted_at`, so "which admin removed this" was unanswerable.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "deleted_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "delete_reason" text;
--> statement-breakpoint
DO $$ BEGIN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_by_user_id_users_id_fk"
        FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
