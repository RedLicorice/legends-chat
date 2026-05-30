-- Plan C: opt-in flag for bots to be DM-able by users.
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "dm_enabled" boolean DEFAULT false NOT NULL;
