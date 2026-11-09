-- @param {String} $1:from
-- @param {String} $2:to
-- The bytes of the attachments uploaded each day from `from` up to `to`,
-- counted as `sumStoredMediaBytes` counts them, for the
-- `instance_media_attachments` measure.
SELECT substr(created_at, 1, 10) AS day,
  SUM(
    COALESCE(file_size, 0) + COALESCE(preview_file_size, 0)
    + CASE WHEN legacy_object_key IS NULL THEN 0 ELSE COALESCE(file_size, 0) END
  ) AS n
FROM media_attachments
WHERE created_at >= $1 AND created_at < $2
GROUP BY day
