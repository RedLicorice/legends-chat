-- cr-m6: `preserveOriginal` (opt out of EXIF/GPS stripping) now requires the
-- dedicated `content.upload.original` permission. Existing deployments seeded
-- role permissions into roles_permissions at install time, so grant it to the
-- admin role here. Other roles get it only if an operator adds it explicitly.
INSERT INTO "roles_permissions" ("role", "permission") VALUES
  ('admin', 'content.upload.original')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- cr-m6: default the global opt-out OFF. Only writes a row when the operator
-- has never set the value, so an explicit `true` is preserved.
INSERT INTO "system_settings" ("key", "value") VALUES ('upload_allow_original', 'false')
ON CONFLICT DO NOTHING;
