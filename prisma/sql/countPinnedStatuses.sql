-- @param {String} $1:accountId
SELECT COUNT(*) AS count FROM status_pins WHERE account_id = $1
