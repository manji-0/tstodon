-- Remote status attachments, captured from the ActivityPub `attachment` array.

ALTER TABLE remote_statuses ADD COLUMN media_json TEXT NOT NULL DEFAULT '[]';
