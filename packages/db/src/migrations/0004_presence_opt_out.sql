ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "presence_opt_out" boolean DEFAULT false NOT NULL;
