CREATE TABLE "passkey_credentials" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL DEFAULT 'Passkey',
  "public_key" bytea NOT NULL,
  "counter" bigint NOT NULL DEFAULT 0,
  "device_type" text NOT NULL DEFAULT 'unknown',
  "backed_up" boolean NOT NULL DEFAULT false,
  "transports" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "passkey_credentials_user_id_idx" ON "passkey_credentials" ("user_id");
