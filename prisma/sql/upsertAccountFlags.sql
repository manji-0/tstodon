-- @param {String} $1:accountId
-- @param {Int} $2:sensitized
-- @param {Int} $3:pending
-- @param {Int} $4:disabled
-- @param {String} $5:now
INSERT INTO account_flags (account_id, sensitized, pending, disabled, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $5)
ON CONFLICT(account_id) DO UPDATE SET sensitized = $2, pending = $3, disabled = $4, updated_at = $5
