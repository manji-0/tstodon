-- @param {String} $1:tokenHash
-- @param {String} $2:applicationId
DELETE FROM oauth_access_tokens WHERE token_hash = $1 AND application_id = $2
