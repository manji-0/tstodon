-- @param {String} $1:like
-- @param {Int} $2:limit
-- @param {Int} $3:offset
SELECT actor_uri, username, domain, inbox_uri, shared_inbox_uri, public_key_id, public_key_pem, display_name, profile_json, moved_to, outbox_uri, featured_uri, fetched_at
FROM remote_actors
WHERE (username LIKE $1 OR (username || '@' || domain) LIKE $1)
  AND actor_uri NOT IN (SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended')
ORDER BY actor_uri DESC LIMIT $2 OFFSET $3
