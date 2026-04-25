ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "is_feed" boolean DEFAULT false NOT NULL;
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "is_home_topic" boolean DEFAULT false NOT NULL;
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "post_roles" jsonb DEFAULT '[]'::jsonb;
