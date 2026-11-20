-- @param {String} $1:previousFetchedAt?
-- @param {String} $2:statusId
-- @param {String} $3:claimedAt
-- Put back the fetch time a failed refresh claimed, unless something else
-- recorded a fetch since.
UPDATE remote_statuses SET poll_fetched_at = $1
WHERE id = $2 AND poll_fetched_at = $3
