-- @param {String} $1:accountId
-- @param {String} $2:now
UPDATE account_flags SET sensitized = 0, updated_at = $2
WHERE account_id = $1
