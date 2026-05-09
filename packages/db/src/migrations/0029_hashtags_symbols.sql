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

UPDATE "messages"
SET "hashtags" = ARRAY(
  SELECT DISTINCT lower(m[1])
  FROM regexp_matches("search_text", '(#[a-zA-Z]\w*)', 'g') AS m
)
WHERE "search_text" IS NOT NULL
  AND "search_text" <> ''
  AND "deleted_at" IS NULL
  AND "search_text" ~ '#[a-zA-Z]';
