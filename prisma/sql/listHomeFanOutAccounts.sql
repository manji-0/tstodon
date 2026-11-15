-- @param {String} $1:accountId
-- @param {String} $2:actorUri
-- @param {String} $3:afterAccountId
-- @param {Int} $4:limit
-- @param {String} $5:entryId
-- Only followers with a `user` or `list` stream open: a hub drops an event
-- for a stream it does not hold, so the others need no render. The
-- followers of the entry's hashtags are asked too; whether the entry is on
-- their home is the home query's answer.
SELECT account_id FROM (
  SELECT follower_account_id AS account_id FROM follows
  WHERE target_account_id = $1 AND kind = 'Accepted' AND follower_account_id > $3
  UNION
  SELECT account_id FROM outbound_follows
  WHERE actor_uri = $2 AND state = 'Accepted' AND account_id > $3
  UNION
  SELECT account_id FROM followed_tags
  WHERE account_id > $3 AND tag_name IN (
    SELECT tag FROM local_status_tags WHERE status_id = $5
    UNION ALL
    SELECT tag FROM remote_status_tags WHERE status_id = $5
  )
)
WHERE EXISTS (
  SELECT 1 FROM stream_subscriptions s
  WHERE s.hub = account_id AND s.stream IN ('user', 'list')
)
ORDER BY account_id LIMIT $4
