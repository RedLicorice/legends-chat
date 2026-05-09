ALTER TABLE "messages" ADD COLUMN "hashtags" text[] DEFAULT '{}'::text[];
CREATE INDEX IF NOT EXISTS "messages_hashtags_gin" ON "messages" USING GIN ("hashtags");

CREATE TABLE IF NOT EXISTS "symbols" (
  "id" serial PRIMARY KEY NOT NULL,
  "symbol" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "linked_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- No backfill: messages store encrypted content; search_text is not a raw-text column.
