-- @param {String} $1:actorUri
SELECT s.id, s.actor_uri, s.object_uri, s.url, s.content_html, s.spoiler_text, s.visibility, s.sensitive, s.language, s.published_at, s.edited_at, s.media_json, s.card_json, s.poll_json
FROM remote_actor_pins p
JOIN remote_statuses s ON s.id = p.status_id
WHERE p.actor_uri = $1 AND s.visibility IN ('public', 'unlisted')
ORDER BY p.position ASC
