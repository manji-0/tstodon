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
-- @param {String} $16:pollJson?
-- @param {String} $17:emojisJson
-- @param {String} $18:quotePolicyJson?
-- The row of a note that was not stored when its object URI was read. It has
-- no ON CONFLICT: a row another delivery stored at the URI since then fails
-- the batch on the unique object_uri, where upsertRemoteStatus.sql would
-- update that row and leave the batch keyed on an id no row holds.
INSERT INTO remote_statuses (
  id, actor_uri, object_uri, url, content_html, spoiler_text,
  visibility, sensitive, language, published_at, media_json, created_at, updated_at, in_reply_to_uri, edited_at, poll_json, emojis_json, quote_policy_json
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
