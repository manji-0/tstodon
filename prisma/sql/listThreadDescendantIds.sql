-- @param {String} $1:startKind
-- @param {String} $2:startId
-- @param {String} $3:actorUrlPrefix
-- @param {Int} $4:maxDepth
-- @param {Int} $5:maxRows
-- The queue pops the deepest row first, the lowest id among equals: Mastodon's
-- `ORDER BY path` pre-order, children by id, with no path to build. Rows come
-- out in the order they leave the queue, and LIMIT stops the walk there.
-- `self_reply` is Mastodon's `in_reply_to_account_id == account_id`, read
-- from the account the reply stored when it was linked.
WITH RECURSIVE tree(kind, id, uri, depth, self_reply) AS (
  SELECT 'Local', s.id, $3 || a.username || '/statuses/' || s.id, 0, 0
  FROM statuses s LEFT JOIN accounts a ON a.id = s.account_id
  WHERE $1 = 'Local' AND s.id = $2
  UNION ALL
  SELECT 'Remote', rs.id, rs.object_uri, 0, 0
  FROM remote_statuses rs
  WHERE $1 = 'Remote' AND rs.id = $2
  UNION ALL
  SELECT 'Local', s.id, $3 || a.username || '/statuses/' || s.id, t.depth + 1,
    coalesce(s.in_reply_to_account_id = s.account_id, 0)
  FROM tree t
  JOIN statuses s ON s.in_reply_to_id = t.id AND s.kind = 'LocalNote'
  LEFT JOIN accounts a ON a.id = s.account_id
  WHERE t.kind = 'Local' AND t.depth < $4 AND s.id != $2
  UNION ALL
  SELECT 'Local', s.id, $3 || a.username || '/statuses/' || s.id, t.depth + 1,
    coalesce(s.in_reply_to_account_id = s.account_id, 0)
  FROM tree t
  JOIN statuses s ON s.in_reply_to_uri = t.uri AND s.kind = 'LocalNote'
  LEFT JOIN accounts a ON a.id = s.account_id
  WHERE t.kind = 'Remote' AND t.depth < $4 AND s.id != $2
  UNION ALL
  SELECT 'Remote', rs.id, rs.object_uri, t.depth + 1,
    coalesce(rs.in_reply_to_actor_uri = rs.actor_uri, 0)
  FROM tree t
  JOIN remote_statuses rs ON rs.in_reply_to_uri = t.uri
  WHERE t.depth < $4 AND rs.id != $2
  ORDER BY 4 DESC, 2 ASC
  LIMIT $5
)
SELECT kind, id, self_reply
FROM tree
WHERE depth > 0
