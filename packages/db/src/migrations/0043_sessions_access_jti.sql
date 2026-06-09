-- Track the active access JWT JTI per session so we can revoke it server-side
-- on perm/role/ban changes. Without this column, revoking a user's access
-- token requires either:
--   (a) a per-user generation counter checked on every getCurrentUser (defeats
--       the point of moving auth state into the JWT), or
--   (b) blanket session deletion and waiting for ACCESS_TTL.
--
-- This column is rewritten on every /auth/refresh; the prior JTI gets pushed
-- to Redis REVOKED_JTI with TTL = remaining JWT lifetime by revokeUserJtis().

BEGIN;
ALTER TABLE sessions ADD COLUMN access_jti text;
ALTER TABLE sessions ADD COLUMN access_expires_at timestamp with time zone;
COMMIT;
