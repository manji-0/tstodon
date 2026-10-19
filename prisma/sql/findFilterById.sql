-- @param {String} $1:id
-- @param {String} $2:accountId
SELECT id, account_id, phrase, context_json, whole_word, irreversible, expires_at, keywords_json
FROM filters WHERE id = $1 AND account_id = $2
