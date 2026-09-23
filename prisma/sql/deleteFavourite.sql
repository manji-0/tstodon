-- @param {String} $1:accountId
-- @param {String} $2:statusId
DELETE FROM favourites WHERE account_id = $1 AND status_id = $2
