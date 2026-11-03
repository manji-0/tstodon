-- @param {String} $1:id
-- @param {String} $2:cardJson
-- @param {String} $3:cardUrl
-- @param {Int} $4:onlyIfMissing
UPDATE statuses SET card_json = $2, card_url = $3
WHERE id = $1 AND ($4 = 0 OR card_json IS NULL OR card_url IS NOT $3)
RETURNING id
