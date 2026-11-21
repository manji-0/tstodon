-- @param {String} $1:objectUri
-- @param {String} $2:exhausted
-- The remote reply at `$1` when its chain of thread jobs stopped at the hop
-- limit: its claim holds `$2`, a time that never goes stale.
SELECT id FROM remote_statuses WHERE object_uri = $1 AND thread_resolve_queued_at = $2
