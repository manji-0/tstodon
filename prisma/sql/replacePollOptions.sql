-- @param {String} $1:pollId
-- @param {String} $2:optionsJson
-- @param {Int} $3:multiple
-- @param {String} $4:expiresAt
-- @param {Int} $5:hideTotals
UPDATE polls SET options_json = $2, multiple = $3, expires_at = $4, hide_totals = $5
WHERE id = $1
RETURNING id
