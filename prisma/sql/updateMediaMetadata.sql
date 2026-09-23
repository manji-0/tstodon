-- @param {String} $1:description
-- @param {Float} $2:focusX?
-- @param {Float} $3:focusY?
-- @param {String} $4:mediaId
-- @param {String} $5:accountId
UPDATE media_attachments
SET description = $1, focus_x = $2, focus_y = $3
WHERE id = $4 AND account_id = $5 AND status_id IS NULL
