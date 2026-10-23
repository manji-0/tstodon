-- @param {String} $1:applicationId
-- @param {String} $2:now
DELETE FROM oauth_authorization_codes WHERE application_id = $1 AND expires_at <= $2
