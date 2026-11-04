-- @param {String} $1:accountId
-- @param {String} $2:applicationId
DELETE FROM oauth_authorization_codes WHERE account_id = $1 AND application_id = $2
