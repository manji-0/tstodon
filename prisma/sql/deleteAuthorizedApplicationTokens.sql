-- @param {String} $1:accountId
-- @param {String} $2:applicationId
DELETE FROM oauth_access_tokens
WHERE account_id = $1 AND application_id = $2 AND web_session_id IS NULL
