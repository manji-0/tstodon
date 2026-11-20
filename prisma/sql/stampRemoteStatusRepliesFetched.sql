-- @param {String} $1:fetchedAt
-- @param {String} $2:statusId
-- Record that the reply tree walk read the remote status's `replies` now.
UPDATE remote_statuses SET replies_fetched_at = $1 WHERE id = $2
