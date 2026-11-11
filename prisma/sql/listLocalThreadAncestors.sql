-- @param {String} $1:id
-- @param {Int} $2:maxSteps
WITH RECURSIVE chain(id, in_reply_to_id, kind, depth) AS (
  SELECT s.id, s.in_reply_to_id, s.kind, 0 FROM statuses s WHERE s.id = $1
  UNION ALL
  SELECT p.id, p.in_reply_to_id, p.kind, chain.depth + 1
  FROM chain JOIN statuses p ON p.id = chain.in_reply_to_id
  WHERE chain.kind = 'LocalNote' AND chain.depth < $2
)
SELECT s.id, s.account_id, s.kind, s.reblog_of_id, s.reblog_of_remote_id, s.in_reply_to_id, s.content_text, COALESCE(s.content_html, '') AS content_html, s.visibility, s.sensitive, COALESCE(s.spoiler_text, '') AS spoiler_text, s.language, s.created_at, s.updated_at, s.poll_id, s.in_reply_to_uri, chain.depth
FROM chain JOIN statuses s ON s.id = chain.id
ORDER BY chain.depth
