-- @param {String} $1:afterId
-- @param {Int} $2:limit
-- The next `limit` attachments after `afterId` whose original (and the legacy
-- copy the rekey job may keep) is not known to be free of metadata and was
-- not passed over, for `StripStoredMediaMetadata`.
SELECT id, object_key, legacy_object_key
FROM media_attachments
WHERE id > $1 AND metadata_stripped_at IS NULL AND metadata_strip_error IS NULL
ORDER BY id
LIMIT $2
