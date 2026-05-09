ALTER TABLE "invite_codes" ADD COLUMN "valid_from" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "invite_codes" ADD COLUMN "disabled_at" timestamptz;
