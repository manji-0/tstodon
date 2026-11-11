-- @param {String} $1:idsJson
-- @param {Int} $2:maxDepth
WITH RECURSIVE reach(id, in_reply_to_id, depth) AS (
  SELECT s.id, s.in_reply_to_id, 1 FROM statuses s WHERE s.id IN (SELECT value FROM json_each($1))
  UNION
  SELECT p.id, p.in_reply_to_id, reach.depth + 1
  FROM reach JOIN statuses p ON p.id = reach.in_reply_to_id
  WHERE reach.depth < $2
)
SELECT DISTINCT id, in_reply_to_id FROM reach
