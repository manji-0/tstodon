-- @param {String} $1:accountId
-- @param {String} $2:moderation
-- @param {String} $3:now
INSERT INTO account_moderation (account_id, moderation, created_at, updated_at)
VALUES ($1, $2, $3, $3)
ON CONFLICT(account_id) DO UPDATE SET moderation = $2, updated_at = $3
