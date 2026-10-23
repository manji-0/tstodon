-- @param {String} $1:accountId
-- @param {Int} $2:limit
-- What the ActivityPub outbox may list: Creates and Announces addressed to
-- Public (`to` or `cc`, on the Create's object). Filtering here, before the
-- LIMIT, keeps a page full.
SELECT id, account_id, kind, payload_json, created_at
FROM outbound_activities
WHERE account_id = $1
  AND kind IN ('Create', 'Announce')
  AND EXISTS (
    SELECT 1 FROM json_each(payload_json, CASE kind WHEN 'Create' THEN '$.object.to' ELSE '$.to' END)
    WHERE value = 'https://www.w3.org/ns/activitystreams#Public'
    UNION ALL
    SELECT 1 FROM json_each(payload_json, CASE kind WHEN 'Create' THEN '$.object.cc' ELSE '$.cc' END)
    WHERE value = 'https://www.w3.org/ns/activitystreams#Public'
  )
ORDER BY id DESC
LIMIT $2
