-- @param {String} $1:description
-- @param {Float} $2:focusX?
-- @param {Float} $3:focusY?
-- @param {String} $4:accountId
-- @param {String} $5:mediaId
UPDATE media_attachments
SET description = $1, focus_x = $2, focus_y = $3
WHERE id = $5 AND account_id = $4 AND status_id IS NULL
