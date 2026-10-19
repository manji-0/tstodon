-- @param {String} $1:accountId
-- @param {Int} $2:disabled
-- @param {String} $3:now
INSERT INTO account_flags (account_id, sensitized, pending, disabled, created_at, updated_at)
VALUES ($1, 0, 0, $2, $3, $3)
ON CONFLICT(account_id) DO UPDATE SET disabled = $2, updated_at = $3
