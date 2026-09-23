-- @param {String} $1:accountId
-- @param {String} $2:conversationId
SELECT last_read_status_id
FROM conversation_reads
WHERE account_id = $1 AND conversation_id = $2
