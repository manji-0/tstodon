-- @param {String} $1:accountId
-- @param {String} $2:deletedAt
-- Keep the username of an account that is about to be deleted.
INSERT OR REPLACE INTO deleted_account_names (username, deleted_at)
SELECT username, $2 FROM accounts WHERE id = $1
