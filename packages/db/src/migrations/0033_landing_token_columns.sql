ALTER TABLE auth_login_tokens
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN telegram_user_id BIGINT,
  ADD COLUMN telegram_username TEXT,
  ADD COLUMN invite_code TEXT;

CREATE INDEX IF NOT EXISTS auth_login_tokens_telegram_user_idx
  ON auth_login_tokens (telegram_user_id)
  WHERE telegram_user_id IS NOT NULL;
