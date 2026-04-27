INSERT INTO "themes" ("id", "name", "is_builtin", "colors", "is_glass", "bg_gradient") VALUES
(
  'cyberpunk',
  'Cyberpunk',
  true,
  '{"bg":"3 4 12","panel":"6 9 22","panel2":"9 14 34","border":"15 45 75","text":"205 235 255","muted":"80 120 160","accent":"0 225 255","accent2":"255 0 185","danger":"255 25 85"}',
  false,
  null
)
ON CONFLICT ("id") DO NOTHING;
