-- Attachments stored before this migration sit at attachments/<account_id>/<id>,
-- a key guessable from the media id. The RekeyLegacyMedia job copies each to a
-- random key; legacy_object_key keeps the old key until that object is deleted.
ALTER TABLE media_attachments ADD COLUMN legacy_object_key TEXT;

UPDATE media_attachments SET legacy_object_key = object_key
WHERE object_key = 'attachments/' || account_id || '/' || id;

CREATE INDEX IF NOT EXISTS idx_media_attachments_legacy_object_key
    ON media_attachments (id) WHERE legacy_object_key IS NOT NULL;
