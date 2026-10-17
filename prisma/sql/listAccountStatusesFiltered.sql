-- @param {String} $1:accountId
-- @param {Int} $2:excludeReplies
-- @param {Int} $3:excludeReblogs
-- @param {Int} $4:onlyMedia
-- @param {String} $5:tagPattern
-- @param {String} $6:maxId
-- @param {Int} $7:limit
SELECT
  id, account_id, kind, reblog_of_id, in_reply_to_id, content_text,
  COALESCE(content_html, '') AS content_html, visibility, sensitive,
  COALESCE(spoiler_text, '') AS spoiler_text, language, created_at, updated_at, poll_id
FROM statuses
WHERE account_id = $1
  AND ($2 = 0 OR in_reply_to_id IS NULL)
  AND ($3 = 0 OR kind <> 'LocalReblog')
  AND ($4 = 0 OR id IN (SELECT status_id FROM media_attachments WHERE status_id IS NOT NULL))
  AND ($5 = '' OR content_text LIKE $5)
  AND ($6 = '' OR id < $6)
ORDER BY id DESC LIMIT $7
