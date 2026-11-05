-- @param {String} $1:afterId
-- @param {Int} $2:limit
SELECT id, content_text, visibility FROM statuses
WHERE kind = 'LocalNote' AND id > $1
ORDER BY id
LIMIT $2
