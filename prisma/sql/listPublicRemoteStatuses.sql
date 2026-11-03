-- @param {Int} $1:limit
-- @param {String} $2:onlyId
-- @param {Int} $3:onlyMedia
-- @param {String} $4:viewerId
-- @param {String} $5:now
-- Leaves out the actors the viewer blocks or mutes (none for '').
SELECT id, actor_uri, object_uri, url, content_html, spoiler_text, visibility, sensitive, language, published_at, edited_at, media_json, card_json, poll_json
FROM remote_statuses
WHERE visibility = 'public'
  AND ($2 = '' OR id = $2)
  AND ($3 = 0 OR media_json NOT IN ('[]', ''))
  AND actor_uri NOT IN (
    SELECT target_actor_uri FROM blocks WHERE blocker_account_id = $4
    UNION
    SELECT target_actor_uri FROM mutes WHERE account_id = $4 AND (expires_at IS NULL OR expires_at > $5)
  )
ORDER BY published_at DESC LIMIT $1
