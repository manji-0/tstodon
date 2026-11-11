-- @param {String} $1:accountId
-- @param {String} $2:conversationIdsJson
SELECT conversation_id, hidden_status_id FROM conversation_hides
WHERE account_id = $1 AND conversation_id IN (SELECT value FROM json_each($2))
