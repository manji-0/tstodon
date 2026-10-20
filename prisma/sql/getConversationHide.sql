-- @param {String} $1:accountId
-- @param {String} $2:conversationId
SELECT hidden_status_id FROM conversation_hides WHERE account_id = $1 AND conversation_id = $2
