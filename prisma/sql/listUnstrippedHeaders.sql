-- @param {String} $1:afterAccountId
-- @param {Int} $2:limit
-- The next `limit` headers after `afterAccountId` not known to be free of
-- metadata and not passed over, for `StripStoredMediaMetadata`.
SELECT account_id, header_object_key AS object_key
FROM account_profiles
WHERE account_id > $1
  AND header_object_key IS NOT NULL
  AND header_metadata_stripped_at IS NULL
  AND header_metadata_strip_error IS NULL
ORDER BY account_id
LIMIT $2
