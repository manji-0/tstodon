-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {String} $3:statusId
-- @param {String} $4:activeSinceDay
-- A follower who mutes the account, notifications on or not, is left out:
-- Mastodon's `filter_from_home` filters a muted author's status. So is one
-- who blocks or mutes an account or actor the note `$3` mentions
-- (`crutches[:active_mentions]`). Only followers who made an authenticated
-- request on or after the UTC day `$4` count, as
-- `followers_for_local_distribution` keeps the users who signed in recently
-- (`User.signed_in_recently`).
SELECT f.follower_account_id, f.languages_json FROM follows f
WHERE f.target_account_id = $1 AND f.follower_account_id != $1 AND f.kind = 'Accepted' AND f.notify != 0
  AND EXISTS (
    SELECT 1 FROM account_activity_days d
    WHERE d.account_id = f.follower_account_id AND d.day >= $4
  )
  AND NOT EXISTS (
    SELECT 1 FROM mutes m
    WHERE m.account_id = f.follower_account_id AND m.target_account_id = $1
      AND (m.expires_at IS NULL OR m.expires_at > $2)
  )
  AND NOT EXISTS (
    SELECT 1 FROM status_mentions sm
    WHERE sm.status_id = $3
      AND (
        EXISTS (
          SELECT 1 FROM blocks b
          WHERE b.blocker_account_id = f.follower_account_id AND b.target_account_id = sm.account_id
        )
        OR EXISTS (
          SELECT 1 FROM mutes m
          WHERE m.account_id = f.follower_account_id AND m.target_account_id = sm.account_id
            AND (m.expires_at IS NULL OR m.expires_at > $2)
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM status_remote_mentions sm
    WHERE sm.status_id = $3
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
