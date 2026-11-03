-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:actorUri
-- @param {String} $4:followActivityId
-- @param {String} $5:createdAt
INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state, created_at)
VALUES ($1, $2, $3, $4, 'Requested', $5)
ON CONFLICT(account_id, actor_uri) DO NOTHING
RETURNING id
