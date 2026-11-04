-- @param {String} $1:accountId
SELECT id, acct, actor_uri, created_at FROM account_aliases WHERE account_id = $1 ORDER BY id
