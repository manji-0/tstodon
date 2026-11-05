-- @param {String} $1:accountId
SELECT object_key FROM media_attachments WHERE account_id = $1
UNION
SELECT legacy_object_key AS object_key FROM media_attachments
WHERE account_id = $1 AND legacy_object_key IS NOT NULL
