-- @param {String} $1:accountId
-- @param {String} $2:localStatusId?
-- @param {String} $3:remoteStatusId?
DELETE FROM bookmarks
WHERE account_id = $1 AND (local_status_id = $2 OR remote_status_id = $3)
RETURNING id
