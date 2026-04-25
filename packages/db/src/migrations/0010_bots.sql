-- topic_bots: join table scoping bots to topics
CREATE TABLE IF NOT EXISTS "topic_bots" (
  "bot_id" uuid NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "topic_id" uuid NOT NULL REFERENCES "topics"("id") ON DELETE CASCADE,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "topic_bots_pk" PRIMARY KEY ("bot_id", "topic_id")
);

CREATE INDEX IF NOT EXISTS "topic_bots_topic_idx" ON "topic_bots" ("topic_id");

-- inline keyboard buttons stored as plaintext alongside encrypted message content
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "inline_keyboard" jsonb;
