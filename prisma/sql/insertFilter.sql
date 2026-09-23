-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:phrase
-- @param {String} $4:contextJson
-- @param {Int} $5:wholeWord
-- @param {Int} $6:irreversible
-- @param {String} $7:expiresAt?
-- @param {String} $8:createdAt
INSERT INTO filters (
  id, account_id, phrase, context_json, whole_word, irreversible, expires_at, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
