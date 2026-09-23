-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:reblogOfId
-- @param {String} $4:createdAt
-- @param {String} $5:updatedAt
INSERT INTO statuses (
  id, account_id, kind, reblog_of_id, content_text, content_html, visibility, sensitive,
  spoiler_text, created_at, updated_at
) VALUES ($1, $2, 'LocalReblog', $3, '', '', 'public', 0, '', $4, $5)
