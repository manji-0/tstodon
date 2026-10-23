-- Media attachments gain alt text and a focal point (PUT /api/v1/media/:id).

ALTER TABLE media_attachments ADD COLUMN description TEXT;
ALTER TABLE media_attachments ADD COLUMN focus_x REAL;
ALTER TABLE media_attachments ADD COLUMN focus_y REAL;
