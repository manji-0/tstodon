-- @param {String} $1:targetAccountId
-- The inboxes of the account's accepted remote followers, leaving out the
-- actors an admin suspended: their follows are severed in pages, and none
-- may get a post in the meantime.
SELECT a.inbox_uri, a.shared_inbox_uri
FROM remote_follows f
JOIN remote_actors a ON a.actor_uri = f.remote_actor_uri
WHERE f.target_account_id = $1 AND f.follow_kind = 'Accepted'
  AND f.remote_actor_uri NOT IN (SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended')
