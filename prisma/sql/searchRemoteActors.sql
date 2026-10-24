-- @param {String} $1:like
-- @param {Int} $2:limit
SELECT actor_uri, username, domain, inbox_uri, shared_inbox_uri, public_key_id, public_key_pem, display_name, profile_json, fetched_at
FROM remote_actors
WHERE username LIKE $1 OR (username || '@' || domain) LIKE $1
ORDER BY actor_uri DESC LIMIT $2
