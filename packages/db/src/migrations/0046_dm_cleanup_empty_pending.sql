-- 0046_dm_cleanup_empty_pending.sql
--
-- One-shot cleanup of pre-refactor pending DMs that have no messages. Before
-- this branch, clicking "DM user" pre-created a `state='pending'` conversation
-- row even though no message had been sent — the recipient saw "X wants to
-- chat" with nothing to read, and there was no way to back out cleanly. The
-- new compose flow only creates a conversation row at first-message-send time,
-- so any pending row with zero `dm_messages` is an artifact of the old UX.
--
-- The cascade FK on dm_participants + dm_messages handles fan-out
-- automatically when the parent row goes away. We scope the delete to
-- 'pending' to be safe — empty 'accepted' / 'blocked' rows are not part of
-- this story and would be deleted incorrectly here.

DELETE FROM dm_conversations
WHERE state = 'pending'
  AND id NOT IN (SELECT DISTINCT conversation_id FROM dm_messages);
