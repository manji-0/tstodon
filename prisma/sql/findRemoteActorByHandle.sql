-- @param {String} $1:username
-- @param {String} $2:domain
SELECT actor_uri, username, domain, inbox_uri, shared_inbox_uri, public_key_id, public_key_pem, display_name, fetched_at
FROM remote_actors WHERE lower(username) = lower($1) AND lower(domain) = lower($2)
ORDER BY fetched_at DESC LIMIT 1
