-- @param {String} $1:accountId
-- @param {String} $2:threadRootStatusId
-- @param {String} $3:createdAt
INSERT INTO status_mutes (account_id, thread_root_status_id, created_at)
VALUES ($1, $2, $3)
ON CONFLICT(account_id, thread_root_status_id) DO NOTHING
