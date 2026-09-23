-- @param {String} $1:accountId
-- @param {String} $2:conversationId
-- @param {String} $3:lastReadStatusId
-- @param {String} $4:updatedAt
INSERT INTO conversation_reads (account_id, conversation_id, last_read_status_id, updated_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT(account_id, conversation_id) DO UPDATE SET
  last_read_status_id = excluded.last_read_status_id,
  updated_at = excluded.updated_at
