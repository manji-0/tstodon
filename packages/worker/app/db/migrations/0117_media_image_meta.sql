-- What an image upload learns through the IMAGES binding: the original's
-- dimensions, the `small` preview stored next to it under its own random key,
-- and the preview's blurhash. All stay NULL when the binding is missing or the
-- processing fails, and for video.
ALTER TABLE media_attachments ADD COLUMN width INTEGER;
ALTER TABLE media_attachments ADD COLUMN height INTEGER;
ALTER TABLE media_attachments ADD COLUMN preview_object_key TEXT;
ALTER TABLE media_attachments ADD COLUMN preview_width INTEGER;
ALTER TABLE media_attachments ADD COLUMN preview_height INTEGER;
ALTER TABLE media_attachments ADD COLUMN blurhash TEXT;
