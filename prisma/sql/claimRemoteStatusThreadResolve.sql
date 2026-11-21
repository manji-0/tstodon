-- @param {String} $1:claimedAt
-- @param {String} $2:statusId
-- Claim the one thread job of a cached remote reply whose parent is not
-- cached; the parent's URI when this claim took it.
UPDATE remote_statuses SET thread_resolve_queued_at = $1
WHERE id = $2
  AND thread_resolve_queued_at IS NULL
  AND in_reply_to_uri IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM remote_statuses AS parent WHERE parent.object_uri = remote_statuses.in_reply_to_uri
  )
RETURNING in_reply_to_uri
