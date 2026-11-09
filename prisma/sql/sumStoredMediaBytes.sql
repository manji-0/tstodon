-- What the `MEDIA` bucket holds, by what holds it, from the recorded sizes
-- (an unknown size counts 0 until the backfill reads it): attachment
-- originals, a legacy copy the rekey job keeps (the original's bytes), and
-- previews; avatars and headers; custom emoji images.
SELECT
  (SELECT COALESCE(SUM(
     COALESCE(file_size, 0) + COALESCE(preview_file_size, 0)
     + CASE WHEN legacy_object_key IS NULL THEN 0 ELSE COALESCE(file_size, 0) END
   ), 0) FROM media_attachments) AS attachments,
  (SELECT COALESCE(SUM(COALESCE(avatar_file_size, 0) + COALESCE(header_file_size, 0)), 0)
   FROM account_profiles) AS profiles,
  (SELECT COALESCE(SUM(COALESCE(image_file_size, 0)), 0) FROM custom_emojis) AS emojis
