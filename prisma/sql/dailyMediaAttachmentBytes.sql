-- @param {String} $1:from
-- @param {String} $2:to
-- The bytes of the attachments uploaded each day from `from` up to `to`,
-- counted as `sumStoredMediaBytes` counts them, for the
-- `instance_media_attachments` measure.
SELECT substr(created_at, 1, 10) AS day,
  SUM(file_size + COALESCE(preview_file_size, 0)) AS n
FROM media_attachments
WHERE created_at >= $1 AND created_at < $2
GROUP BY day
