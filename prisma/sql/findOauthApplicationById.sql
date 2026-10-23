-- @param {String} $1:id
SELECT id, client_id, client_secret_hash, name, website, redirect_uris, scopes, created_at
FROM oauth_applications WHERE id = $1
