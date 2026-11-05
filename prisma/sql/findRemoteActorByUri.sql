-- @param {String} $1:actorUri
SELECT actor_uri, username, domain, inbox_uri, shared_inbox_uri, public_key_id, public_key_pem, display_name, profile_json, moved_to, outbox_uri, featured_uri, fetched_at, last_webfingered_at
FROM remote_actors WHERE actor_uri = $1
