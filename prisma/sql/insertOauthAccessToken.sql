-- @param {String} $1:id
-- @param {String} $2:tokenHash
-- @param {String} $3:applicationId
-- @param {String} $4:accountId
-- @param {String} $5:scopes
-- @param {String} $6:createdAt
INSERT INTO oauth_access_tokens (id, token_hash, application_id, account_id, scopes, created_at)
VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6)
