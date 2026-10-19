-- @param {String} $1:id
-- @param {String} $2:cardJson
UPDATE statuses SET card_json = $2 WHERE id = $1
RETURNING id
