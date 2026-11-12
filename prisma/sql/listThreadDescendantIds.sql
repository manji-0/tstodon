-- @param {String} $1:startKind
-- @param {String} $2:startId
-- @param {String} $3:actorUrlPrefix
-- @param {Int} $4:maxDepth
-- @param {Int} $5:maxRows
WITH RECURSIVE tree(kind, id, uri, depth) AS (
  SELECT 'Local', s.id, $3 || a.username || '/statuses/' || s.id, 0
  FROM statuses s LEFT JOIN accounts a ON a.id = s.account_id
  WHERE $1 = 'Local' AND s.id = $2
  UNION ALL
  SELECT 'Remote', rs.id, rs.object_uri, 0
  FROM remote_statuses rs
  WHERE $1 = 'Remote' AND rs.id = $2
  UNION
  SELECT 'Local', s.id, $3 || a.username || '/statuses/' || s.id, t.depth + 1
  FROM tree t
  JOIN statuses s ON s.in_reply_to_id = t.id AND s.kind = 'LocalNote'
  LEFT JOIN accounts a ON a.id = s.account_id
  WHERE t.kind = 'Local' AND t.depth < $4
  UNION
  SELECT 'Local', s.id, $3 || a.username || '/statuses/' || s.id, t.depth + 1
  FROM tree t
  JOIN statuses s ON s.in_reply_to_uri = t.uri AND s.kind = 'LocalNote'
  LEFT JOIN accounts a ON a.id = s.account_id
  WHERE t.kind = 'Remote' AND t.depth < $4
  UNION
  SELECT 'Remote', rs.id, rs.object_uri, t.depth + 1
  FROM tree t
  JOIN remote_statuses rs ON rs.in_reply_to_uri = t.uri
  WHERE t.depth < $4
  LIMIT $5
)
SELECT kind, id, MIN(depth) AS depth
FROM tree
WHERE depth > 0 AND NOT (kind = $1 AND id = $2)
GROUP BY kind, id
ORDER BY depth, id
