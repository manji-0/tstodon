-- @param {String} $1:accountId
-- @param {String} $2:statusId
SELECT 1 AS present FROM status_pins WHERE account_id = $1 AND status_id = $2 LIMIT 1
