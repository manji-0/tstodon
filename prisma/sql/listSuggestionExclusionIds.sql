-- @param {String} $1:viewerId
-- @param {String} $2:now
SELECT target_account_id AS id FROM follows
  WHERE follower_account_id = $1 AND target_account_id IS NOT NULL
UNION
SELECT target_account_id FROM blocks
  WHERE blocker_account_id = $1 AND target_account_id IS NOT NULL
UNION
SELECT target_account_id FROM mutes
  WHERE account_id = $1 AND target_account_id IS NOT NULL
    AND (expires_at IS NULL OR expires_at > $2)
UNION
SELECT target_account_id FROM suggestion_dismissals
  WHERE account_id = $1
