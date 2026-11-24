-- @param {String} $1:actorUri
-- @param {String} $2:viewerId
-- @param {Int} $3:excludeReplies
-- @param {Int} $4:onlyMedia
-- @param {String} $5:tagged
-- None when the viewer blocks the actor's account domain or the instance suspends it or the actor URI's host,
-- or a domain above either (a viewer of '' blocks none; the viewer's block names its exact domain).
SELECT s.id, s.actor_uri, s.object_uri, s.url, s.content_html, s.spoiler_text, s.visibility, s.sensitive, s.language, s.published_at, s.edited_at, s.media_json, s.card_json, s.poll_json, s.quote_policy_json
FROM remote_actor_pins p
-- CROSS JOIN keeps the actor's pins as the outer loop; without table statistics the planner
-- would otherwise walk idx_remote_statuses_visibility_id over every public status.
CROSS JOIN remote_statuses s ON s.id = p.status_id
WHERE p.actor_uri = $1 AND s.visibility IN ('public', 'unlisted')
  AND s.actor_uri NOT IN (
    SELECT actor_uri FROM remote_actors
    WHERE host IN (SELECT lower(domain) FROM account_domain_blocks WHERE account_id = $2)
      OR uri_host IN (SELECT lower(domain) FROM account_domain_blocks WHERE account_id = $2)
  )
  AND s.actor_uri NOT IN (
    SELECT actor_uri FROM remote_actor_domain_rules WHERE severity = 'suspend'
  )
  -- The profile's other filters, as `AccountStatusesFilter` applies them to pins.
  AND ($3 = 0 OR s.in_reply_to_uri IS NULL OR s.in_reply_to_actor_uri = s.actor_uri)
  AND ($4 = 0 OR s.media_json NOT IN ('[]', ''))
  AND ($5 = '' OR EXISTS (
    SELECT 1 FROM remote_status_tags t WHERE t.status_id = s.id AND t.tag = $5
  ))
ORDER BY p.position ASC
