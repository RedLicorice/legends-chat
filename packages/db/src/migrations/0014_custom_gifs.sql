CREATE TABLE IF NOT EXISTS custom_gifs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  thumbnail_url text,
  title text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
