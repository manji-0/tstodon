-- @param {String} $1:accountId
-- What one account's media take in the `MEDIA` bucket, counted as
-- `sumStoredMediaBytes` counts them: its attachments, avatar and header.
SELECT
  (SELECT COALESCE(SUM(
     COALESCE(file_size, 0) + COALESCE(preview_file_size, 0)
     + CASE WHEN legacy_object_key IS NULL THEN 0 ELSE COALESCE(file_size, 0) END
   ), 0) FROM media_attachments WHERE account_id = $1) AS attachments,
  (SELECT COALESCE(SUM(COALESCE(avatar_file_size, 0) + COALESCE(header_file_size, 0)), 0)
   FROM account_profiles WHERE account_id = $1) AS profiles
