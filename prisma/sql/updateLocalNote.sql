-- @param {String} $1:id
-- @param {String} $2:contentText
-- @param {String} $3:contentHtml
-- @param {String} $4:visibility
-- @param {Int} $5:sensitive
-- @param {String} $6:spoilerText
-- @param {String} $7:language?
-- @param {String} $8:updatedAt
-- @param {String} $9:accountId
UPDATE statuses SET
  content_text = $2,
  content_html = $3,
  visibility = $4,
  sensitive = $5,
  spoiler_text = $6,
  language = $7,
  updated_at = $8
WHERE id = $1 AND account_id = $9
RETURNING id
