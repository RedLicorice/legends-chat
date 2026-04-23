CREATE TABLE IF NOT EXISTS "user_key_bundles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"identity_public_key" text NOT NULL,
	"key_bundle" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "e2ee_sender_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"distributor_user_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"encrypted_key" text NOT NULL,
	"key_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "e2ee_sender_keys_uniq_idx" ON "e2ee_sender_keys" ("topic_id","distributor_user_id","recipient_user_id");
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "search_vector" tsvector;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_search_vector_idx" ON "messages" USING GIN ("search_vector");
--> statement-breakpoint
ALTER TABLE "user_key_bundles" ADD CONSTRAINT "user_key_bundles_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "e2ee_sender_keys" ADD CONSTRAINT "e2ee_sender_keys_topic_id_topics_id_fk"
	FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "e2ee_sender_keys" ADD CONSTRAINT "e2ee_sender_keys_distributor_user_id_users_id_fk"
	FOREIGN KEY ("distributor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "e2ee_sender_keys" ADD CONSTRAINT "e2ee_sender_keys_recipient_user_id_users_id_fk"
	FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
