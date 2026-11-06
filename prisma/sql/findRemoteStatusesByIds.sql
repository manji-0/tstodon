-- @param {String} $1:idsJson
SELECT id, actor_uri, object_uri, url, content_html, spoiler_text, visibility, sensitive, language, published_at, edited_at, media_json, card_json, poll_json, emojis_json, quote_policy_json
FROM remote_statuses WHERE id IN (SELECT value FROM json_each($1))
