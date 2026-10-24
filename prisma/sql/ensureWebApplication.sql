-- @param {String} $1:id
-- @param {String} $2:scopes
-- @param {String} $3:createdAt
INSERT OR IGNORE INTO oauth_applications (id, client_id, client_secret_hash, name, website, redirect_uris, scopes, created_at)
VALUES ($1, $1, '', 'Web', NULL, 'urn:ietf:wg:oauth:2.0:oob', $2, $3)
