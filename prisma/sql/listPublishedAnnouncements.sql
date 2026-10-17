-- @param {String} $1:now
SELECT id, content, starts_at, ends_at, all_day, published_at, created_at, updated_at
FROM announcements
WHERE published_at IS NOT NULL
  AND published_at <= $1
  AND (starts_at IS NULL OR starts_at <= $1)
  AND (ends_at IS NULL OR ends_at > $1)
ORDER BY published_at DESC, id DESC
