ALTER TABLE "invite_quota_config" ALTER COLUMN "daily_limit" DROP NOT NULL;
ALTER TABLE "invite_quota_config" ALTER COLUMN "daily_limit" DROP DEFAULT;
