-- The byte size of each object tstodon stores in the `MEDIA` bucket, as
-- stored (uploads after metadata stripping), for the admin `space_usage`
-- dimension, the `instance_media_attachments` measure and the export page's
-- media storage. NULL is not known yet: the upload path, the metadata
-- backfill's rewrite and the custom emoji forms write the size of what they
-- store; the `BackfillStoredMediaSizes` job HEADs the objects of the rows
-- stored before this migration and records their size (0 for a missing
-- object). A row's sizes go with the row, or with its key when an image is
-- removed. A legacy copy the rekey job keeps holds the original's bytes, so
-- it is counted at `file_size`.
ALTER TABLE media_attachments ADD COLUMN file_size INTEGER;
ALTER TABLE media_attachments ADD COLUMN preview_file_size INTEGER;
ALTER TABLE account_profiles ADD COLUMN avatar_file_size INTEGER;
ALTER TABLE account_profiles ADD COLUMN header_file_size INTEGER;
ALTER TABLE custom_emojis ADD COLUMN image_file_size INTEGER;

-- The backfill's page query: once every size is known, a run reads nothing.
CREATE INDEX IF NOT EXISTS idx_media_attachments_size_pending
  ON media_attachments(id)
  WHERE file_size IS NULL OR (preview_object_key IS NOT NULL AND preview_file_size IS NULL);
CREATE INDEX IF NOT EXISTS idx_account_profiles_avatar_size_pending
  ON account_profiles(account_id)
  WHERE avatar_object_key IS NOT NULL AND avatar_file_size IS NULL;
CREATE INDEX IF NOT EXISTS idx_account_profiles_header_size_pending
  ON account_profiles(account_id)
  WHERE header_object_key IS NOT NULL AND header_file_size IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_emojis_size_pending
  ON custom_emojis(id)
  WHERE image_file_size IS NULL;
