-- @param {String} $1:accountId
-- @param {String} $2:day
INSERT OR IGNORE INTO account_activity_days (account_id, day)
SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = $1)
