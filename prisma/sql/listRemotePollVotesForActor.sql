-- @param {String} $1:pollId
-- @param {String} $2:actorUri
-- undistributed: no `DistributePollUpdate` job has started since the vote was
-- counted, so the poll's `Update` does not carry it yet.
SELECT
  v.option_index,
  v.created_at >= coalesce(p.update_distributed_at, '') AS undistributed
FROM remote_poll_votes v
JOIN polls p ON p.id = v.poll_id
WHERE v.poll_id = $1 AND v.actor_uri = $2
