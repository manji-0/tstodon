-- The media sweep (`deleteUnattachedMedia`) reads the oldest media no status
-- holds; idx_media_attachments_status only covers attached rows.
CREATE INDEX IF NOT EXISTS idx_media_attachments_unattached
    ON media_attachments (created_at) WHERE status_id IS NULL;
