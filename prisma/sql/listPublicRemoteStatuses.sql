-- @param {Int} $1:limit
-- @param {String} $2:onlyId
-- @param {Int} $3:onlyMedia
-- @param {String} $4:viewerId
-- @param {String} $5:now
-- @param {String} $6:before
-- @param {String} $7:after
-- @param {Int} $8:ascending
-- Newest id first (oldest first when $8 = 1), between the exclusive bounds $7 and $6 ('' leaves a side open).
-- Leaves out the actors the viewer blocks or mutes, the actors on a domain the viewer blocks or the instance silences or suspends (matched against both the account domain and the actor URI's host), and the actors an admin silenced or suspended (nothing for a viewer of '').
SELECT id, actor_uri, object_uri, url, content_html, spoiler_text, visibility, sensitive, language, published_at, edited_at, media_json, card_json, poll_json, emojis_json
FROM remote_statuses
WHERE visibility = 'public'
  AND ($2 = '' OR id = $2)
  AND ($3 = 0 OR media_json NOT IN ('[]', ''))
  AND ($6 = '' OR id < $6)
  AND ($7 = '' OR id > $7)
  AND actor_uri NOT IN (
    SELECT target_actor_uri FROM blocks WHERE blocker_account_id = $4
    UNION
    SELECT target_actor_uri FROM mutes WHERE account_id = $4 AND (expires_at IS NULL OR expires_at > $5)
  )
  AND actor_uri NOT IN (
    SELECT actor_uri FROM remote_actors
    WHERE host IN (SELECT lower(domain) FROM account_domain_blocks WHERE account_id = $4)
      OR uri_host IN (SELECT lower(domain) FROM account_domain_blocks WHERE account_id = $4)
      OR host IN (SELECT lower(domain) FROM domain_blocks WHERE severity IN ('silence', 'suspend'))
      OR uri_host IN (SELECT lower(domain) FROM domain_blocks WHERE severity IN ('silence', 'suspend'))
  )
  AND actor_uri NOT IN (SELECT actor_uri FROM remote_actor_moderation WHERE moderation IS NOT NULL)
ORDER BY CASE WHEN $8 = 1 THEN id END ASC, id DESC LIMIT $1
