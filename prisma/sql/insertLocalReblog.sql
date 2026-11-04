-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:localStatusId?
-- @param {String} $4:remoteStatusId?
-- @param {String} $5:createdAt
-- @param {String} $6:updatedAt
-- @param {String} $7:visibility
INSERT INTO statuses (
  id, account_id, kind, reblog_of_id, reblog_of_remote_id, content_text, content_html, visibility,
  sensitive, spoiler_text, created_at, updated_at
) VALUES ($1, $2, 'LocalReblog', $3, $4, '', '', $7, 0, '', $5, $6)
