-- @param {String} $1:accountId
SELECT id, account_id, phrase, context_json, whole_word, irreversible, expires_at
FROM filters WHERE account_id = $1 ORDER BY created_at DESC
