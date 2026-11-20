-- @param {String} $1:rootId
-- @param {Int} $2:depth
-- @param {String} $3:afterId
-- @param {Int} $4:limit
-- The cached public and unlisted replies `depth` levels below the remote
-- status `rootId`, in id order after `afterId`: one level of its reply tree,
-- found through `in_reply_to_uri`, each with when its `replies` were last
-- read. Depth 0 is the root itself. A status already on the path from the
-- root is not visited again, so a self-reply or a reply cycle ends there,
-- as Mastodon's `FetchAllRepliesWorker` keeps the URIs it has seen.
WITH RECURSIVE tree(id, object_uri, depth, path) AS (
  SELECT id, object_uri, 0, ',' || id || ',' FROM remote_statuses WHERE id = $1
  UNION ALL
  SELECT r.id, r.object_uri, tree.depth + 1, tree.path || r.id || ',' FROM tree
  JOIN remote_statuses r ON r.in_reply_to_uri = tree.object_uri
  WHERE tree.depth < $2 AND r.visibility IN ('public', 'unlisted')
    AND instr(tree.path, ',' || r.id || ',') = 0
)
SELECT tree.id, tree.object_uri, s.replies_fetched_at
FROM tree JOIN remote_statuses s ON s.id = tree.id
WHERE tree.depth = $2 AND tree.id > $3 ORDER BY tree.id LIMIT $4
