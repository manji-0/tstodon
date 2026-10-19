-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:phrase
-- @param {String} $4:contextJson
-- @param {Int} $5:wholeWord
-- @param {Int} $6:irreversible
-- @param {String} $7:expiresAt?
-- @param {String} $8:keywordsJson
UPDATE filters
SET phrase = $3, context_json = $4, whole_word = $5, irreversible = $6, expires_at = $7, keywords_json = $8
WHERE id = $1 AND account_id = $2
RETURNING id
