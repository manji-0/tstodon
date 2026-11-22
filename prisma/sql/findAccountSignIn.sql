-- @param {String} $1:accountId
SELECT current_sign_in_at FROM accounts WHERE id = $1
