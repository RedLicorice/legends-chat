CREATE TABLE "message_edits" (
  "id" bigserial PRIMARY KEY,
  "message_id" bigint NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "edited_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "previous_content" bytea NOT NULL,
  "previous_nonce" bytea NOT NULL,
  "key_id" uuid NOT NULL REFERENCES "encryption_keys"("id"),
  "edited_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "message_edits_message_idx" ON "message_edits"("message_id");
