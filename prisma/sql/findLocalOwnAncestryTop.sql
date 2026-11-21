-- @param {String} $1:statusId
-- @param {Int} $2:maxDepth
-- The top of the run of local statuses that starts at `statusId` and climbs
-- `in_reply_to_id` while the parent has the same author, at most `maxDepth`
-- steps: how many steps it climbed, and the top's own parent (both NULL when
-- the top is a root).
WITH RECURSIVE run (id, account_id, in_reply_to_id, in_reply_to_uri, depth) AS (
  SELECT id, account_id, in_reply_to_id, in_reply_to_uri, 0 FROM statuses WHERE id = $1
  UNION ALL
  SELECT parent.id, parent.account_id, parent.in_reply_to_id, parent.in_reply_to_uri, run.depth + 1
  FROM run
  JOIN statuses AS parent ON parent.id = run.in_reply_to_id
  WHERE parent.account_id = run.account_id AND run.depth < $2
)
SELECT depth, in_reply_to_id, in_reply_to_uri FROM run ORDER BY depth DESC LIMIT 1
