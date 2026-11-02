-- @param {String} $1:id
-- @param {String} $2:actorUri
-- @param {String} $3:objectUri
-- @param {String} $4:url?
-- @param {String} $5:contentHtml
-- @param {String} $6:spoilerText
-- @param {String} $7:visibility
-- @param {Int} $8:sensitive
-- @param {String} $9:language?
-- @param {String} $10:publishedAt
-- @param {String} $11:mediaJson
-- @param {String} $12:createdAt
-- @param {String} $13:updatedAt
-- @param {String} $14:inReplyToUri?
-- @param {String} $15:editedAt?
INSERT INTO remote_statuses (
  id, actor_uri, object_uri, url, content_html, spoiler_text,
  visibility, sensitive, language, published_at, media_json, created_at, updated_at, in_reply_to_uri, edited_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
ON CONFLICT(object_uri) DO UPDATE SET
  card_json = CASE WHEN content_html = excluded.content_html THEN card_json ELSE NULL END,
  card_url = CASE WHEN content_html = excluded.content_html THEN card_url ELSE NULL END,
  content_html = excluded.content_html,
  spoiler_text = excluded.spoiler_text,
  visibility = excluded.visibility,
  sensitive = excluded.sensitive,
  language = excluded.language,
  published_at = excluded.published_at,
  url = excluded.url,
  media_json = excluded.media_json,
  edited_at = coalesce(excluded.edited_at, edited_at),
  updated_at = excluded.updated_at
