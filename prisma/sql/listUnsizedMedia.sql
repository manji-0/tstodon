-- @param {Int} $1:afterSource
-- @param {String} $2:afterId
-- @param {Int} $3:limit
-- The next `limit` stored objects of unknown size, for
-- `BackfillStoredMediaSizes`, in source order (0 attachments, 1 avatars,
-- 2 headers, 3 custom emojis) then id, after `afterId` of source
-- `afterSource`. `object_key` / `preview_object_key` are NULL when that
-- object's size is already known (or there is no preview). Each branch reads
-- at most `limit` rows of its partial index, so a run with nothing left to do
-- reads nothing.
SELECT source, id, object_key, preview_object_key FROM (
  SELECT * FROM (
    SELECT 0 AS source, id,
      CASE WHEN file_size IS NULL THEN object_key END AS object_key,
      CASE WHEN preview_file_size IS NULL THEN preview_object_key END AS preview_object_key
    FROM media_attachments
    WHERE $1 <= 0 AND id > (CASE WHEN $1 = 0 THEN $2 ELSE '' END)
      AND (file_size IS NULL OR (preview_object_key IS NOT NULL AND preview_file_size IS NULL))
    ORDER BY id
    LIMIT $3
  )
  UNION ALL
  SELECT * FROM (
    SELECT 1 AS source, account_id AS id, avatar_object_key AS object_key,
      NULL AS preview_object_key
    FROM account_profiles
    WHERE $1 <= 1 AND account_id > (CASE WHEN $1 = 1 THEN $2 ELSE '' END)
      AND avatar_object_key IS NOT NULL AND avatar_file_size IS NULL
    ORDER BY account_id
    LIMIT $3
  )
  UNION ALL
  SELECT * FROM (
    SELECT 2 AS source, account_id AS id, header_object_key AS object_key,
      NULL AS preview_object_key
    FROM account_profiles
    WHERE $1 <= 2 AND account_id > (CASE WHEN $1 = 2 THEN $2 ELSE '' END)
      AND header_object_key IS NOT NULL AND header_file_size IS NULL
    ORDER BY account_id
    LIMIT $3
  )
  UNION ALL
  SELECT * FROM (
    SELECT 3 AS source, id, object_key, NULL AS preview_object_key
    FROM custom_emojis
    WHERE $1 <= 3 AND id > (CASE WHEN $1 = 3 THEN $2 ELSE '' END)
      AND image_file_size IS NULL
    ORDER BY id
    LIMIT $3
  )
)
ORDER BY source, id
LIMIT $3
