ALTER TABLE "topics"
  ADD COLUMN "password_hash" text,
  ADD COLUMN "password_version" integer NOT NULL DEFAULT 0,
  ADD COLUMN "password_reentry_days" integer NOT NULL DEFAULT 7;
