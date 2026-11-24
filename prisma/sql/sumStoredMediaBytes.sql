-- What the `MEDIA` bucket holds, by what holds it, from the recorded sizes:
-- attachment originals and previews; avatars and headers; custom emoji images.
SELECT
  (SELECT COALESCE(SUM(file_size + COALESCE(preview_file_size, 0)), 0)
   FROM media_attachments) AS attachments,
  (SELECT COALESCE(SUM(COALESCE(avatar_file_size, 0) + COALESCE(header_file_size, 0)), 0)
   FROM account_profiles) AS profiles,
  (SELECT COALESCE(SUM(image_file_size), 0) FROM custom_emojis) AS emojis
