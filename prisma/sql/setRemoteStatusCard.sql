-- @param {String} $1:id
-- @param {String} $2:cardJson
-- @param {String} $3:cardUrl
UPDATE remote_statuses SET card_json = $2, card_url = $3, updated_at = CURRENT_TIMESTAMP
  WHERE id = $1
RETURNING id
