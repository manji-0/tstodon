-- @param {String} $1:afterId
-- @param {Int} $2:includeKept
-- @param {Int} $3:limit
SELECT id, account_id, object_key, legacy_object_key
FROM media_attachments
WHERE id > $1
  AND (object_key = 'attachments/' || account_id || '/' || id
       OR ($2 = 1 AND legacy_object_key IS NOT NULL))
ORDER BY id
LIMIT $3
