-- Which stored originals are known to carry no metadata (EXIF / GPS / XMP,
-- video location atoms; see `UploadMetadata.forUpload`). Uploads since the
-- stripping on upload are marked when stored; the `StripStoredMediaMetadata`
-- job rewrites the objects stored before it and marks them. An object the job
-- cannot rewrite (unreadable container, over its size cap) keeps its bytes
-- and gets the reason in `*_metadata_strip_error`, so the job passes it over
-- until an operator clears the reason.
ALTER TABLE media_attachments ADD COLUMN metadata_stripped_at TEXT;
ALTER TABLE media_attachments ADD COLUMN metadata_strip_error TEXT;
ALTER TABLE account_profiles ADD COLUMN avatar_metadata_stripped_at TEXT;
ALTER TABLE account_profiles ADD COLUMN avatar_metadata_strip_error TEXT;
ALTER TABLE account_profiles ADD COLUMN header_metadata_stripped_at TEXT;
ALTER TABLE account_profiles ADD COLUMN header_metadata_strip_error TEXT;

-- The job's page query: once every row is marked, a run reads nothing.
CREATE INDEX IF NOT EXISTS idx_media_attachments_metadata_pending
  ON media_attachments(id)
  WHERE metadata_stripped_at IS NULL AND metadata_strip_error IS NULL;
