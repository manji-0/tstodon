-- @param {Int} $1:limit
SELECT id, actor_uri, object_uri, url, content_html, spoiler_text, visibility, sensitive, language, published_at
FROM remote_statuses
WHERE visibility = 'public'
ORDER BY published_at DESC LIMIT $1
