-- @param {String} $1:objectUri
SELECT id, actor_uri, object_uri, url, content_html, spoiler_text, visibility, sensitive, language, published_at
FROM remote_statuses WHERE object_uri = $1
