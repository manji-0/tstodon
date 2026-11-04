-- @param {String} $1:actorUri
-- @param {String} $2:viewerId
-- None when the viewer blocks the actor's domain or the instance suspends it (a viewer of '' blocks none).
SELECT s.id, s.actor_uri, s.object_uri, s.url, s.content_html, s.spoiler_text, s.visibility, s.sensitive, s.language, s.published_at, s.edited_at, s.media_json, s.card_json, s.poll_json, s.emojis_json
FROM remote_actor_pins p
JOIN remote_statuses s ON s.id = p.status_id
WHERE p.actor_uri = $1 AND s.visibility IN ('public', 'unlisted')
  AND s.actor_uri NOT IN (
    SELECT actor_uri FROM remote_actors
    WHERE host IN (
      SELECT lower(domain) FROM account_domain_blocks WHERE account_id = $2
      UNION
      SELECT lower(domain) FROM domain_blocks WHERE severity = 'suspend'
    )
  )
ORDER BY p.position ASC
