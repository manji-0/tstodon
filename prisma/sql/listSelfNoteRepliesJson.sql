-- @param {String} $1:noteIdsJson
-- @param {String} $2:afterId
-- @param {Int} $3:limit
-- For each local note in the JSON array `noteIdsJson`, up to `limit` of its
-- author's own public and unlisted replies after `afterId` ('' for none),
-- oldest first, as Mastodon's `Status#self_replies`.
SELECT p.id AS note_id, s.id
FROM statuses p
JOIN statuses s ON s.id IN (
  SELECT r.id
  FROM statuses r
  WHERE r.in_reply_to_id = p.id AND r.account_id = p.account_id
    AND r.kind = 'LocalNote'
    AND r.visibility IN ('public', 'unlisted')
    AND r.id > $2
  ORDER BY r.id
  LIMIT $3
)
WHERE p.id IN (SELECT value FROM json_each($1))
ORDER BY p.id, s.id
