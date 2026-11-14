-- @param {String} $1:id
-- @param {String} $2:cardJson
-- @param {String} $3:cardUrl
-- @param {Int} $4:onlyIfMissing
-- `updated_at` is written as the instants the other writers of the row
-- store, not as CURRENT_TIMESTAMP's 'YYYY-MM-DD HH:MM:SS': the heal of a row
-- whose edit date does not read orders a document against it.
UPDATE remote_statuses SET card_json = $2, card_url = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = $1 AND ($4 = 0 OR card_json IS NULL OR card_url IS NOT $3)
RETURNING id
