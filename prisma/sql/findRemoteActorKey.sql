-- @param {String} $1:keyId
-- A key (`remote_actor_keys`) and the cached actor that publishes it.
SELECT k.key_id, k.type, k.public_key_pem,
  a.actor_uri, a.username, a.domain, a.inbox_uri, a.shared_inbox_uri, a.display_name, a.profile_json, a.moved_to, a.outbox_uri, a.featured_uri, a.featured_tags_uri, a.followers_uri, a.following_uri, a.fetched_at, a.last_webfingered_at
FROM remote_actor_keys AS k JOIN remote_actors AS a ON a.actor_uri = k.actor_uri
WHERE k.key_id = $1
