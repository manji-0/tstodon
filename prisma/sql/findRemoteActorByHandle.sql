-- @param {String} $1:username
-- @param {String} $2:domain
SELECT actor_uri, username, domain, inbox_uri, shared_inbox_uri, public_key_id, public_key_pem, display_name, profile_json, moved_to, outbox_uri, featured_uri, followers_uri, following_uri, fetched_at, last_webfingered_at
FROM remote_actors WHERE lower(username) = lower($1) AND lower(domain) = lower($2)
-- Handles are not unique: the row WebFinger confirmed last wins, then the
-- latest fetch, then the URI, so the answer never depends on row order.
ORDER BY last_webfingered_at IS NULL, last_webfingered_at DESC, fetched_at DESC, actor_uri
LIMIT 1
