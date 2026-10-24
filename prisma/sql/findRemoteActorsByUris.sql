-- @param {String} $1:urisJson
SELECT actor_uri, username, domain, inbox_uri, shared_inbox_uri, public_key_id, public_key_pem, display_name, profile_json, fetched_at
FROM remote_actors WHERE actor_uri IN (SELECT value FROM json_each($1))
