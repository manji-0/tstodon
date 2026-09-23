-- @param {String} $1:publicKeyId
SELECT actor_uri, username, domain, inbox_uri, shared_inbox_uri, public_key_id, public_key_pem, display_name, fetched_at
FROM remote_actors WHERE public_key_id = $1
