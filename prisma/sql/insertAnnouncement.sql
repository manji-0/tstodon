-- @param {String} $1:id
-- @param {String} $2:content
-- @param {String} $3:startsAt?
-- @param {String} $4:endsAt?
-- @param {Int} $5:allDay
-- @param {String} $6:publishedAt?
-- @param {String} $7:now
INSERT INTO announcements (id, content, starts_at, ends_at, all_day, published_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
