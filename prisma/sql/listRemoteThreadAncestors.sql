-- @param {String} $1:objectUri
-- @param {Int} $2:maxSteps
WITH RECURSIVE chain(id, in_reply_to_uri, depth, path) AS (
  SELECT r.id, r.in_reply_to_uri, 1, ',' || r.id || ',' FROM remote_statuses r WHERE r.object_uri = $1
  UNION ALL
  SELECT p.id, p.in_reply_to_uri, chain.depth + 1, chain.path || p.id || ','
  FROM chain JOIN remote_statuses p ON p.object_uri = chain.in_reply_to_uri
  WHERE chain.depth < $2 AND instr(chain.path, ',' || p.id || ',') = 0
)
SELECT r.id, r.actor_uri, r.object_uri, r.url, r.content_html, r.spoiler_text, r.visibility, r.sensitive, r.language, r.published_at, r.edited_at, r.media_json, r.card_json, r.poll_json, r.emojis_json, r.quote_policy_json, r.in_reply_to_uri, chain.depth
FROM chain JOIN remote_statuses r ON r.id = chain.id
ORDER BY chain.depth
