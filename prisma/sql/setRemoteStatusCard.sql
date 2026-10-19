-- @param {String} $1:id
-- @param {String} $2:cardJson
UPDATE remote_statuses SET card_json = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1
RETURNING id
