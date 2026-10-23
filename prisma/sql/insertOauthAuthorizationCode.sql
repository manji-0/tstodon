-- @param {String} $1:codeHash
-- @param {String} $2:applicationId
-- @param {String} $3:accountId
-- @param {String} $4:redirectUri
-- @param {String} $5:scopes
-- @param {String} $6:codeChallenge
-- @param {String} $7:codeChallengeMethod
-- @param {String} $8:expiresAt
-- @param {String} $9:createdAt
INSERT INTO oauth_authorization_codes (code_hash, application_id, account_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, created_at)
VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, $9)
