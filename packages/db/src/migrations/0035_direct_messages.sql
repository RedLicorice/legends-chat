-- Direct messages (1:1) subsystem — plaintext core (Plan A)
CREATE TYPE "public"."dm_principal_type" AS ENUM ('user', 'bot');
CREATE TYPE "public"."dm_state" AS ENUM ('pending', 'accepted', 'blocked');

CREATE TABLE IF NOT EXISTS "dm_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dm_key" text NOT NULL,
  "is_e2ee" boolean DEFAULT false NOT NULL,
  "state" "dm_state" DEFAULT 'pending' NOT NULL,
  "initiator_type" "dm_principal_type" NOT NULL,
  "initiator_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_message_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "dm_conversations_dm_key_idx" ON "dm_conversations" ("dm_key");

CREATE TABLE IF NOT EXISTS "dm_participants" (
  "conversation_id" uuid NOT NULL REFERENCES "dm_conversations"("id") ON DELETE CASCADE,
  "principal_type" "dm_principal_type" NOT NULL,
  "principal_id" text NOT NULL,
  "last_read_message_id" bigint,
  CONSTRAINT "dm_participants_pk" PRIMARY KEY ("conversation_id", "principal_type", "principal_id")
);
CREATE INDEX IF NOT EXISTS "dm_participants_principal_idx" ON "dm_participants" ("principal_type", "principal_id");

CREATE TABLE IF NOT EXISTS "dm_messages" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "dm_conversations"("id") ON DELETE CASCADE,
  "sender_type" "dm_principal_type" NOT NULL,
  "sender_id" text NOT NULL,
  "content_ciphertext" bytea NOT NULL,
  "content_nonce" bytea NOT NULL,
  "key_id" uuid NOT NULL REFERENCES "encryption_keys"("id"),
  "reply_to_message_id" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "edited_at" timestamp with time zone,
  "deleted_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "dm_messages_conv_id_idx" ON "dm_messages" ("conversation_id", "id");

CREATE TABLE IF NOT EXISTS "dm_blocks" (
  "blocker_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "blocked_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "dm_blocks_pk" PRIMARY KEY ("blocker_user_id", "blocked_user_id")
);
