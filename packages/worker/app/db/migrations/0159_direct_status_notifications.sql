-- A local direct note used to send the `status` notification ("notify me
-- when this account posts") to every follower who asked for it, and the
-- notification rendered the note to a follower it does not mention. Mastodon
-- sends it only to the followers the home fan-out reaches
-- (`FeedInsertWorker#notify?`), which for a direct note are the mentioned
-- ones. This drops the stored ones that went to anyone else; a held one in
-- `notification_requests` goes with it (`ON DELETE CASCADE`).
--
-- Cost: one scan of `notifications`, with a primary key lookup in `statuses`
-- per `status` notification and in `status_mentions` per one on a direct note.
DELETE FROM notifications
WHERE kind = 'status'
  AND EXISTS (
    SELECT 1 FROM statuses s WHERE s.id = notifications.status_id AND s.visibility = 'direct'
  )
  AND NOT EXISTS (
    SELECT 1 FROM status_mentions m
    WHERE m.status_id = notifications.status_id AND m.account_id = notifications.account_id
  );
