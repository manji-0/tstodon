-- @param {String} $1:accountId
SELECT thread_root_status_id FROM status_mutes WHERE account_id = $1
