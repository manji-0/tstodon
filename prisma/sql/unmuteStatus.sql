-- @param {String} $1:accountId
-- @param {String} $2:threadRootStatusId
DELETE FROM status_mutes WHERE account_id = $1 AND thread_root_status_id = $2
RETURNING thread_root_status_id
