-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:inReplyToId?
-- @param {String} $4:text
-- @param {String} $5:contentHtml
-- @param {String} $6:visibility
-- @param {Int} $7:sensitive
-- @param {String} $8:spoilerText
-- @param {String} $9:language?
-- @param {String} $10:createdAt
-- @param {String} $11:updatedAt
INSERT INTO statuses (
  id, account_id, kind, in_reply_to_id, content_text, content_html, visibility, sensitive,
  spoiler_text, language, created_at, updated_at
) VALUES ($1, $2, 'LocalNote', $3, $4, $5, $6, $7, $8, $9, $10, $11)
