CREATE TABLE IF NOT EXISTS "themes" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "is_builtin" boolean NOT NULL DEFAULT false,
  "colors" jsonb NOT NULL DEFAULT '{}',
  "is_glass" boolean NOT NULL DEFAULT false,
  "bg_gradient" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "themes" ("id", "name", "is_builtin", "colors", "is_glass") VALUES
(
  'dark',
  'Dark',
  true,
  '{"bg":"11 13 18","panel":"20 24 33","panel2":"26 31 43","border":"38 45 59","text":"230 233 242","muted":"138 147 166","accent":"124 92 255","accent2":"92 200 255","danger":"255 92 124"}',
  false
),
(
  'matte-glass',
  'Matte Glass',
  true,
  '{"bg":"15 12 35","panel":"27 22 54","panel2":"35 30 68","border":"61 53 101","text":"238 239 252","muted":"154 156 192","accent":"139 112 255","accent2":"92 212 255","danger":"255 98 132"}',
  true
)
ON CONFLICT ("id") DO NOTHING;
