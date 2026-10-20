-- @param {Int} $1:limit
SELECT id, content_html FROM remote_statuses
WHERE tags_indexed = 0
ORDER BY id DESC
LIMIT $1
