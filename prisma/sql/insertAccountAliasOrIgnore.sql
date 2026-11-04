-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:acct
-- @param {String} $4:actorUri
-- @param {String} $5:createdAt
INSERT OR IGNORE INTO account_aliases (id, account_id, acct, actor_uri, created_at)
VALUES ($1, $2, $3, $4, $5)
