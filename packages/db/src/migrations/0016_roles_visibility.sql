-- Create roles table
CREATE TABLE IF NOT EXISTS "roles" (
  "name" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "is_system" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Seed default system roles
INSERT INTO "roles" ("name", "label", "is_system", "sort_order") VALUES
  ('user', 'User', true, 0),
  ('moderator', 'Moderator', true, 10),
  ('admin', 'Admin', true, 20)
ON CONFLICT ("name") DO NOTHING;

-- Convert users.role enum → text
ALTER TABLE "users" ALTER COLUMN "role" TYPE text;
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user';

-- Convert roles_permissions.role enum → text (composite PK must be dropped first)
DO $$
DECLARE pk_name text;
BEGIN
  SELECT constraint_name INTO pk_name
  FROM information_schema.table_constraints
  WHERE table_name = 'roles_permissions' AND constraint_type = 'PRIMARY KEY'
  LIMIT 1;
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE roles_permissions DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;
ALTER TABLE "roles_permissions" ALTER COLUMN "role" TYPE text;
ALTER TABLE "roles_permissions" ADD PRIMARY KEY ("role", "permission");

-- Convert invite_quota_config.role enum → text (it IS the PK)
ALTER TABLE "invite_quota_config" DROP CONSTRAINT IF EXISTS "invite_quota_config_pkey";
ALTER TABLE "invite_quota_config" ALTER COLUMN "role" TYPE text;
ALTER TABLE "invite_quota_config" ADD PRIMARY KEY ("role");

-- Convert invite_codes.role enum → text
ALTER TABLE "invite_codes" ALTER COLUMN "role" TYPE text;
ALTER TABLE "invite_codes" ALTER COLUMN "role" SET DEFAULT 'user';

-- Drop the enum (CASCADE cleans up any remaining references)
DROP TYPE IF EXISTS "user_role" CASCADE;

-- Add visibility_permission to topics
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "visibility_permission" text;
