-- @param {String} $1:accountId
-- @param {String} $2:conversationId
-- @param {String} $3:hiddenStatusId
-- @param {String} $4:updatedAt
INSERT INTO conversation_hides (account_id, conversation_id, hidden_status_id, created_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT(account_id, conversation_id) DO UPDATE SET hidden_status_id = excluded.hidden_status_id
