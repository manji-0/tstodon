-- A status lists its attachments in the order its media_ids gave them, as
-- Mastodon's ordered_media_attachment_ids does. Attachments stored before this
-- migration keep the order they were shown in, created_at with rowid breaking ties.
ALTER TABLE media_attachments ADD COLUMN position INTEGER;

UPDATE media_attachments
SET position = (
    SELECT COUNT(*) FROM media_attachments AS earlier
    WHERE earlier.status_id = media_attachments.status_id
      AND (earlier.created_at < media_attachments.created_at
        OR (earlier.created_at = media_attachments.created_at
          AND earlier.rowid < media_attachments.rowid))
)
WHERE status_id IS NOT NULL;
