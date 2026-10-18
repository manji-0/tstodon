-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:description?
-- @param {Float} $4:focusX?
-- @param {Float} $5:focusY?
UPDATE media_attachments
SET description = $3, focus_x = $4, focus_y = $5
WHERE id = $1 AND account_id = $2
RETURNING id
