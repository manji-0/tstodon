-- @param {String} $1:statusId
-- @param {Int} $2:maxDepth
-- The top of the run of cached remote statuses that starts at `statusId` and
-- climbs `in_reply_to_uri` while the parent has the same author, at most
-- `maxDepth` steps: how many steps it climbed, and the top's own parent URI
-- (NULL when the top is a root).
WITH RECURSIVE run (id, actor_uri, in_reply_to_uri, depth) AS (
  SELECT id, actor_uri, in_reply_to_uri, 0 FROM remote_statuses WHERE id = $1
  UNION ALL
  SELECT parent.id, parent.actor_uri, parent.in_reply_to_uri, run.depth + 1
  FROM run
  JOIN remote_statuses AS parent ON parent.object_uri = run.in_reply_to_uri
  WHERE parent.actor_uri = run.actor_uri AND run.depth < $2
)
SELECT depth, in_reply_to_uri FROM run ORDER BY depth DESC LIMIT 1
