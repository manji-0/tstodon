-- @param {String} $1:accountId
-- @param {String} $2:now
INSERT INTO account_flags (account_id, sensitized, pending, created_at, updated_at)
VALUES ($1, 0, 1, $2, $2)
ON CONFLICT(account_id) DO UPDATE SET pending = 1, updated_at = $2
