ALTER TABLE media_attachments ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE media_attachments ADD COLUMN focus_x REAL;
ALTER TABLE media_attachments ADD COLUMN focus_y REAL;
ALTER TABLE media_attachments ADD COLUMN preview_object_key TEXT;
ALTER TABLE media_attachments ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE media_attachments ADD COLUMN blurhash TEXT;
ALTER TABLE media_attachments ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1;
