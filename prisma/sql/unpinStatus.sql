-- @param {String} $1:accountId
-- @param {String} $2:statusId
DELETE FROM status_pins WHERE account_id = $1 AND status_id = $2
RETURNING status_id
