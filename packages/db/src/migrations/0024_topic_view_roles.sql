ALTER TABLE "topics" ADD COLUMN "view_roles" jsonb DEFAULT '[]';
UPDATE "topics" SET "view_roles" = '[]' WHERE "view_roles" IS NULL;
ALTER TABLE "topics" ALTER COLUMN "view_roles" SET NOT NULL;
ALTER TABLE "topics" DROP COLUMN IF EXISTS "visibility_permission";

-- Migrate existing post_roles / read_roles data to roles_permissions
INSERT INTO roles_permissions (role, permission)
SELECT r.role_name, 'topic.' || t.slug || '.post'
FROM topics t,
     jsonb_array_elements_text(COALESCE(t.post_roles, '[]'::jsonb)) AS r(role_name)
WHERE jsonb_array_length(COALESCE(t.post_roles, '[]'::jsonb)) > 0
ON CONFLICT DO NOTHING;

INSERT INTO roles_permissions (role, permission)
SELECT r.role_name, 'topic.' || t.slug || '.read'
FROM topics t,
     jsonb_array_elements_text(COALESCE(t.read_roles, '[]'::jsonb)) AS r(role_name)
WHERE jsonb_array_length(COALESCE(t.read_roles, '[]'::jsonb)) > 0
ON CONFLICT DO NOTHING;
