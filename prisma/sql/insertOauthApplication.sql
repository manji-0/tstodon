-- @param {String} $1:id
-- @param {String} $2:clientId
-- @param {String} $3:clientSecretHash
-- @param {String} $4:name
-- @param {String} $5:website
-- @param {String} $6:redirectUris
-- @param {String} $7:scopes
-- @param {String} $8:createdAt
INSERT INTO oauth_applications (id, client_id, client_secret_hash, name, website, redirect_uris, scopes, created_at)
VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8)
