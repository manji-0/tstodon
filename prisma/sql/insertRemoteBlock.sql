-- @param {String} $1:actorUri
-- @param {String} $2:accountId
-- @param {String} $3:createdAt
INSERT OR IGNORE INTO remote_blocks (actor_uri, account_id, created_at)
VALUES ($1, $2, $3)
