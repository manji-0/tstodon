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
-- @param {String} $11:createdAt
-- @param {String} $12:updatedAt
INSERT INTO remote_statuses (
  id, actor_uri, object_uri, url, content_html, spoiler_text,
  visibility, sensitive, language, published_at, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT(object_uri) DO UPDATE SET
  content_html = excluded.content_html,
  spoiler_text = excluded.spoiler_text,
  visibility = excluded.visibility,
  sensitive = excluded.sensitive,
  language = excluded.language,
  published_at = excluded.published_at,
  url = excluded.url,
  updated_at = excluded.updated_at
