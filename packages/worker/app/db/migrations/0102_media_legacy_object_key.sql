-- Attachments stored before this migration sit at attachments/<account_id>/<id>,
-- a key guessable from the media id. The RekeyLegacyMedia job finds them by that
-- key, copies each to a random key, and keeps the old key here while the object
-- stored under it is still there.
ALTER TABLE media_attachments ADD COLUMN legacy_object_key TEXT;

CREATE INDEX IF NOT EXISTS idx_media_attachments_legacy_object_key
    ON media_attachments (id) WHERE legacy_object_key IS NOT NULL;
