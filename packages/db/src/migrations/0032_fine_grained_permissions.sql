-- users temp role
ALTER TABLE "users" ADD COLUMN "role_expires_at" timestamptz;
ALTER TABLE "users" ADD COLUMN "role_fallback" text;
--> statement-breakpoint

-- bots role
ALTER TABLE "bots" ADD COLUMN "role" text NOT NULL DEFAULT 'bot';
ALTER TABLE "bots" ADD COLUMN "role_expires_at" timestamptz;
ALTER TABLE "bots" ADD COLUMN "role_fallback" text;
--> statement-breakpoint

-- topics reply_roles
ALTER TABLE "topics" ADD COLUMN "reply_roles" jsonb DEFAULT '[]' NOT NULL;
--> statement-breakpoint

-- topic_principal_grants
CREATE TABLE "topic_principal_grants" (
  "topic_id" uuid NOT NULL,
  "principal_type" text NOT NULL,
  "principal_id" uuid NOT NULL,
  "action" text NOT NULL,
  "effect" text NOT NULL,
  "expires_at" timestamptz,
  "granted_by" uuid,
  "granted_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "topic_principal_grants_principal_type_check" CHECK ("principal_type" IN ('user', 'bot')),
  CONSTRAINT "topic_principal_grants_effect_check" CHECK ("effect" IN ('allow', 'deny')),
  CONSTRAINT "topic_principal_grants_pk" PRIMARY KEY ("topic_id","principal_type","principal_id","action")
);
--> statement-breakpoint
ALTER TABLE "topic_principal_grants" ADD CONSTRAINT "topic_principal_grants_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "topic_principal_grants" ADD CONSTRAINT "topic_principal_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_principal_grants_topic_idx" ON "topic_principal_grants" ("topic_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_principal_grants_principal_idx" ON "topic_principal_grants" ("principal_type","principal_id");
--> statement-breakpoint

-- principal_permission_overrides
CREATE TABLE "principal_permission_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "principal_type" text NOT NULL,
  "principal_id" uuid NOT NULL,
  "permission" text NOT NULL,
  "effect" text NOT NULL,
  "expires_at" timestamptz,
  "granted_by" uuid,
  "granted_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "principal_permission_overrides_principal_type_check" CHECK ("principal_type" IN ('user', 'bot')),
  CONSTRAINT "principal_permission_overrides_effect_check" CHECK ("effect" IN ('allow', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "principal_permission_overrides" ADD CONSTRAINT "principal_permission_overrides_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "principal_permission_overrides_uniq" ON "principal_permission_overrides" ("principal_type","principal_id","permission");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "principal_permission_overrides_principal_idx" ON "principal_permission_overrides" ("principal_type","principal_id");
--> statement-breakpoint

-- seed bot roles
INSERT INTO "roles" ("name", "label", "is_system", "sort_order") VALUES
  ('bot', 'Bot', true, 90),
  ('bot-extended', 'Bot (Extended)', true, 91)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "roles_permissions" ("role", "permission") VALUES
  ('bot', 'messages.delete.own'),
  ('bot', 'content.attachment'),
  ('bot-extended', 'messages.delete.own'),
  ('bot-extended', 'messages.edit.own'),
  ('bot-extended', 'content.attachment'),
  ('bot-extended', 'content.gif.upload')
ON CONFLICT DO NOTHING;
