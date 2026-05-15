-- Backfill canonical role permissions for built-in roles.
-- Idempotent: ON CONFLICT DO NOTHING preserves any operator customizations
-- (added or removed perms via admin UI) while ensuring baseline grants exist.
-- Necessary because 0032 introduced fine-grained perm strings without
-- migrating existing user/moderator/admin role rows; previously these were
-- only populated by `just seed` (destructive replace).

INSERT INTO "roles_permissions" ("role", "permission") VALUES
  ('user', 'messages.delete.own'),
  ('user', 'messages.edit.own'),
  ('user', 'messages.flag'),
  ('user', 'invites.create'),
  ('user', 'content.attachment'),
  ('moderator', 'messages.delete.own'),
  ('moderator', 'messages.delete.any'),
  ('moderator', 'messages.edit.own'),
  ('moderator', 'messages.edit.any'),
  ('moderator', 'messages.flag'),
  ('moderator', 'invites.create'),
  ('moderator', 'moderation.queue.review'),
  ('moderator', 'users.ban.direct'),
  ('moderator', 'users.mute.direct'),
  ('moderator', 'users.mute.lift'),
  ('moderator', 'topics.create'),
  ('moderator', 'content.attachment'),
  ('moderator', 'content.gif.upload'),
  ('admin', 'topics.create'),
  ('admin', 'topics.manage'),
  ('admin', 'messages.delete.own'),
  ('admin', 'messages.delete.any'),
  ('admin', 'messages.edit.own'),
  ('admin', 'messages.edit.any'),
  ('admin', 'messages.flag'),
  ('admin', 'invites.create'),
  ('admin', 'invites.create.elevated'),
  ('admin', 'bots.manage'),
  ('admin', 'moderation.queue.review'),
  ('admin', 'users.ban.direct'),
  ('admin', 'users.ban.lift'),
  ('admin', 'users.mute.direct'),
  ('admin', 'users.mute.lift'),
  ('admin', 'admin.config'),
  ('admin', 'content.attachment'),
  ('admin', 'content.gif.upload')
ON CONFLICT DO NOTHING;
