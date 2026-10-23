-- @param {String} $1:accountId
-- @param {String} $2:authUserId
UPDATE accounts SET auth_user_id = $2 WHERE id = $1
