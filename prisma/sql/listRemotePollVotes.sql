-- The viewer's own votes plus every account's still-optimistic ones, for a page of statuses.
-- @param {String} $1:viewerId
-- @param {String} $2:statusIdsJson
SELECT status_id, account_id, choice_index, optimistic
FROM remote_poll_own_votes
WHERE status_id IN (SELECT value FROM json_each($2))
  AND (optimistic = 1 OR account_id = $1)
ORDER BY status_id, account_id, choice_index
