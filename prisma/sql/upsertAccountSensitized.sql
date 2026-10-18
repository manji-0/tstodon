-- @param {String} $1:accountId
-- @param {String} $2:now
INSERT INTO account_flags (account_id, sensitized, created_at, updated_at)
VALUES ($1, 1, $2, $2)
ON CONFLICT(account_id) DO UPDATE SET sensitized = 1, updated_at = $2
