-- @param {String} $1:viewerId
-- @param {String} $2:idsJson
WITH RECURSIVE chain(start_id, id, account_id, in_reply_to_id) AS (
  SELECT s.id, s.id, s.account_id, s.in_reply_to_id
  FROM statuses s WHERE s.id IN (SELECT value FROM json_each($2))
  UNION
  SELECT chain.start_id, p.id, p.account_id, p.in_reply_to_id
  FROM chain JOIN statuses p ON p.id = chain.in_reply_to_id
  WHERE p.kind = 'LocalNote' AND p.visibility = 'direct'
)
SELECT DISTINCT chain.start_id FROM chain
WHERE chain.account_id = $1
   OR EXISTS (SELECT 1 FROM status_mentions m WHERE m.status_id = chain.id AND m.account_id = $1)
