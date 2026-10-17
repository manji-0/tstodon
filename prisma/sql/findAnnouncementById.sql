-- @param {String} $1:id
SELECT id, content, starts_at, ends_at, all_day, published_at, created_at, updated_at
FROM announcements WHERE id = $1 LIMIT 1
