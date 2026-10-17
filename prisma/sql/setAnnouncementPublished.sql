-- @param {String} $1:id
-- @param {String} $2:publishedAt?
-- @param {String} $3:now
UPDATE announcements
SET published_at = $2, updated_at = $3
WHERE id = $1
RETURNING id
