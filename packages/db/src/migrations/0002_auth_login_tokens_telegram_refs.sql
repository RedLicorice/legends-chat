ALTER TABLE "auth_login_tokens" ADD COLUMN "telegram_chat_id" bigint;--> statement-breakpoint
ALTER TABLE "auth_login_tokens" ADD COLUMN "telegram_message_id" integer;
