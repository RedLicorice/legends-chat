CREATE TABLE IF NOT EXISTS "uploads" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid,
    "bucket" text NOT NULL,
    "url" text NOT NULL,
    "storage_path" text NOT NULL,
    "mime_type" text NOT NULL,
    "size_bytes" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
    ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uploads_url_idx" ON "uploads" ("url");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uploads_user_idx" ON "uploads" ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uploads_sweep_idx" ON "uploads" ("deleted_at","created_at");
