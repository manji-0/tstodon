-- @param {String} $1:accountId
SELECT acct, target_uri, moved_at, cancelled_at FROM account_moves WHERE account_id = $1
