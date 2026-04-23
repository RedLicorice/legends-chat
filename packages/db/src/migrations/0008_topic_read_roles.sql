ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "read_roles" jsonb DEFAULT '[]'::jsonb;
