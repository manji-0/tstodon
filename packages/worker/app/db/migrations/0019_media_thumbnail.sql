-- A custom thumbnail of a video (Mastodon's `thumbnail` attachment, which
-- `POST /api/v2/media` and `PUT /api/v1/media/:id` take). It is stored as the
-- row's preview (`preview_object_key`, its size, its blurhash), which the REST
-- `preview_url` and `meta.small` already show; this column is its stored
-- type, set only for a custom thumbnail, which a note federates as its
-- `Document`'s `icon`. NULL for an image's own preview and for no preview.
ALTER TABLE media_attachments ADD COLUMN thumbnail_content_type TEXT;
