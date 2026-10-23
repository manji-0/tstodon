-- @param {String} $1:codeHash
DELETE FROM oauth_authorization_codes WHERE code_hash = $1
RETURNING application_id, account_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at
