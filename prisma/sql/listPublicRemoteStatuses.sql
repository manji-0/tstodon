-- @param {Int} $1:limit
-- @param {String} $2:onlyId
-- @param {Int} $3:onlyMedia
SELECT id, actor_uri, object_uri, url, content_html, spoiler_text, visibility, sensitive, language, published_at, edited_at, media_json, card_json, poll_json
FROM remote_statuses
WHERE visibility = 'public'
  AND ($2 = '' OR id = $2)
  AND ($3 = 0 OR media_json NOT IN ('[]', ''))
ORDER BY published_at DESC LIMIT $1
