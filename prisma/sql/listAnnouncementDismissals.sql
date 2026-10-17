-- @param {String} $1:accountId
SELECT announcement_id FROM account_announcement_dismissals WHERE account_id = $1
