-- @param {String} $1:id
SELECT id, actor_uri, object_uri, url, content_html, spoiler_text, visibility, sensitive, language, published_at
FROM remote_statuses WHERE id = $1
