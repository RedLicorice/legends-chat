ALTER TABLE "themes" ADD COLUMN IF NOT EXISTS "custom_css" text;

INSERT INTO "themes" ("id", "name", "is_builtin", "colors", "is_glass", "bg_gradient", "custom_css") VALUES
(
  'legends',
  'Legends',
  true,
  '{"bg":"18 10 5","panel":"30 18 10","panel2":"42 26 14","border":"105 60 25","text":"238 218 180","muted":"168 138 92","accent":"215 75 20","accent2":"148 45 205","danger":"200 40 50"}',
  false,
  null,
  null
)
ON CONFLICT ("id") DO NOTHING;
