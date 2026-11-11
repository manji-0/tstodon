-- @param {String} $1:idsJson
-- @param {Int} $2:maxSteps
WITH RECURSIVE chain(start_id, start_direct, id, in_reply_to_id, in_reply_to_uri, direct, depth) AS (
  SELECT s.id, s.kind = 'LocalNote' AND s.visibility = 'direct', s.id, s.in_reply_to_id, s.in_reply_to_uri,
         s.kind = 'LocalNote' AND s.visibility = 'direct', 0
  FROM statuses s WHERE s.id IN (SELECT value FROM json_each($1))
  UNION ALL
  SELECT chain.start_id, chain.start_direct, p.id, p.in_reply_to_id, p.in_reply_to_uri, 1, chain.depth + 1
  FROM chain JOIN statuses p ON p.id = chain.in_reply_to_id
  WHERE chain.direct = 1 AND chain.depth < $2 AND p.kind = 'LocalNote' AND p.visibility = 'direct'
)
SELECT start_id, start_direct, id AS root_id, in_reply_to_uri AS root_in_reply_to_uri, MAX(depth) AS depth
FROM chain GROUP BY start_id
