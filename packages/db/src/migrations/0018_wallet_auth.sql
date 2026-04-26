ALTER TABLE "users" ADD COLUMN "wallet_address" text;
CREATE UNIQUE INDEX "users_wallet_address_idx" ON "users" ("wallet_address") WHERE "wallet_address" IS NOT NULL;
