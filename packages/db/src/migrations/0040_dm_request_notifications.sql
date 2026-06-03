-- DM requests as bell notifications.
--
-- The DM "request" flow (pending state) is moving out of the sidebar and into
-- the notification bell. The recipient sees a `dm_request` notification with
-- Accept / Decline actions; the existing sidebar entry only appears once the
-- conversation is accepted.
--
-- The `notifications.type` column is a plain `text` field (see 0012), not a
-- pgEnum, so adding a new variant requires no DDL — only a backfill of one
-- `dm_request` notification per existing pending DM conversation, addressed
-- to the recipient (the participant that did NOT initiate). The initiator is
-- recorded directly on `dm_conversations.initiator_id` (see 0035), so we don't
-- have to infer it from participant join order.
--
-- The IS DISTINCT FROM guard skips rows that already have a backfilled
-- notification, so this migration is safe to re-run conceptually (drizzle
-- only applies it once, but the guard means it's idempotent against any
-- future "DM request opened" code path that may also insert via the helper).
INSERT INTO notifications (user_id, type, payload)
SELECT
  recip.principal_id::uuid AS user_id,
  'dm_request' AS type,
  jsonb_build_object(
    'conversation_id', c.id,
    'sender_user_id', c.initiator_id,
    'sender_display_name', COALESCE(u.display_name, 'Unknown'),
    'sender_avatar_url', u.avatar_url,
    'is_e2ee', c.is_e2ee
  ) AS payload
FROM dm_conversations c
JOIN dm_participants recip
  ON recip.conversation_id = c.id
 AND recip.principal_type = 'user'
 AND recip.principal_id <> c.initiator_id
LEFT JOIN users u
  ON u.id = c.initiator_id::uuid
WHERE c.state = 'pending'
  AND c.initiator_type = 'user'
  AND NOT EXISTS (
    SELECT 1 FROM notifications n
     WHERE n.user_id = recip.principal_id::uuid
       AND n.type = 'dm_request'
       AND (n.payload->>'conversation_id') = c.id::text
  );
