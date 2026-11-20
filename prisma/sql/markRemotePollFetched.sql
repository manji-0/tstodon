-- @param {String} $1:fetchedAt
-- @param {String} $2:statusId
UPDATE remote_statuses SET poll_fetched_at = $1
WHERE id = $2 AND poll_json IS NOT NULL
