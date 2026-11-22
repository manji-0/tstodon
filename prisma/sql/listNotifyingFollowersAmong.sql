-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {String} $3:statusId
-- @param {String} $4:activeSince
-- @param {String} $5:followerIdsJson
-- `listNotifyingFollowers` for the followers among `$5` only: a direct
-- note's `status` notification reaches only the accounts it mentions
-- (`deliver_to_mentioned_followers!`), so their follows are sought by the
-- follower, not paged through every follower of the account. The same
-- activity, mute, block and mention rules apply; the unary `+` on target
-- columns is explained there. Here it also keeps the follows sought by
-- follower (`$5`), not by the account every one of them follows.
SELECT f.follower_account_id, f.languages_json FROM follows f
WHERE f.follower_account_id IN (SELECT value FROM json_each($5))
  AND +f.target_account_id = $1 AND f.follower_account_id != $1 AND f.kind = 'Accepted' AND f.notify != 0
  AND EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = f.follower_account_id AND a.current_sign_in_at >= $4
  )
  AND NOT EXISTS (
    SELECT 1 FROM mutes m
    WHERE m.account_id = f.follower_account_id AND +m.target_account_id = $1
      AND (m.expires_at IS NULL OR m.expires_at > $2)
  )
  AND NOT EXISTS (
    SELECT 1 FROM status_mentions sm
    WHERE sm.status_id = $3 AND sm.silent = 0
      AND (
        EXISTS (
          SELECT 1 FROM blocks b
          WHERE b.blocker_account_id = f.follower_account_id AND +b.target_account_id = sm.account_id
        )
        OR EXISTS (
          SELECT 1 FROM mutes m
          WHERE m.account_id = f.follower_account_id AND +m.target_account_id = sm.account_id
            AND (m.expires_at IS NULL OR m.expires_at > $2)
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM status_remote_mentions sm
    WHERE sm.status_id = $3 AND sm.silent = 0
      AND (
        EXISTS (
          SELECT 1 FROM blocks b
          WHERE b.blocker_account_id = f.follower_account_id AND b.target_actor_uri = sm.actor_uri
        )
        OR EXISTS (
          SELECT 1 FROM mutes m
          WHERE m.account_id = f.follower_account_id AND m.target_actor_uri = sm.actor_uri
            AND (m.expires_at IS NULL OR m.expires_at > $2)
        )
      )
  )
