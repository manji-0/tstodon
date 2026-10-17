-- @param {String} $1:id
-- @param {String} $2:content
-- @param {String} $3:startsAt?
-- @param {String} $4:endsAt?
-- @param {Int} $5:allDay
-- @param {String} $6:publishedAt?
-- @param {String} $7:now
UPDATE announcements
SET content = $2, starts_at = $3, ends_at = $4, all_day = $5, published_at = $6, updated_at = $7
WHERE id = $1
RETURNING id
