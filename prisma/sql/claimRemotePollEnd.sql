-- @param {String} $1:at
-- @param {String} $2:statusId
-- @param {String} $3:unlessAt
-- @param {String} $4:votedStatusId
-- Record that the end of a remote poll a local account voted on is queued for
-- `at`, unless it already is.
UPDATE remote_statuses SET poll_end_queued_at = $1
WHERE id = $2 AND poll_end_queued_at IS NOT $3
  AND EXISTS (SELECT 1 FROM remote_poll_own_votes v WHERE v.status_id = $4)
RETURNING id
