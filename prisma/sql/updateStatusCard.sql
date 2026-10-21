-- @param {String} $1:id
-- @param {String} $2:cardJson
-- @param {String} $3:cardUrl
UPDATE statuses SET card_json = $2, card_url = $3 WHERE id = $1
RETURNING id
