-- @param {String} $1:startKind
-- @param {String} $2:startId
-- @param {String} $3:actorUrlPrefix
-- @param {Int} $4:maxDepth
-- @param {Int} $5:maxRows
WITH RECURSIVE tree(kind, id, uri, depth, path, parent_kind, parent_id) AS (
  SELECT 'Local', s.id, $3 || a.username || '/statuses/' || s.id, 0, s.id, NULL, NULL
  FROM statuses s LEFT JOIN accounts a ON a.id = s.account_id
  WHERE $1 = 'Local' AND s.id = $2
  UNION ALL
  SELECT 'Remote', rs.id, rs.object_uri, 0, rs.id, NULL, NULL
  FROM remote_statuses rs
  WHERE $1 = 'Remote' AND rs.id = $2
  UNION
  SELECT 'Local', s.id, $3 || a.username || '/statuses/' || s.id, t.depth + 1,
    t.path || '/' || s.id, t.kind, t.id
  FROM tree t
  JOIN statuses s ON s.in_reply_to_id = t.id AND s.kind = 'LocalNote'
  LEFT JOIN accounts a ON a.id = s.account_id
  WHERE t.kind = 'Local' AND t.depth < $4 AND instr('/' || t.path || '/', '/' || s.id || '/') = 0
  UNION
  SELECT 'Local', s.id, $3 || a.username || '/statuses/' || s.id, t.depth + 1,
    t.path || '/' || s.id, t.kind, t.id
  FROM tree t
  JOIN statuses s ON s.in_reply_to_uri = t.uri AND s.kind = 'LocalNote'
  LEFT JOIN accounts a ON a.id = s.account_id
  WHERE t.kind = 'Remote' AND t.depth < $4 AND instr('/' || t.path || '/', '/' || s.id || '/') = 0
  UNION
  SELECT 'Remote', rs.id, rs.object_uri, t.depth + 1, t.path || '/' || rs.id, t.kind, t.id
  FROM tree t
  JOIN remote_statuses rs ON rs.in_reply_to_uri = t.uri
  WHERE t.depth < $4 AND instr('/' || t.path || '/', '/' || rs.id || '/') = 0
  ORDER BY 5
  LIMIT $5
)
SELECT kind, id, parent_kind, parent_id
FROM tree
WHERE depth > 0
ORDER BY path
