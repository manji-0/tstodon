-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {String} $3:statusId
-- @param {String} $4:activeSince
-- @param {String} $5:afterFollowId
-- @param {Int} $6:limit
-- A follower who mutes the account, notifications on or not, is left out:
-- Mastodon's `filter_from_home` filters a muted author's status. So is one
-- who blocks or mutes an account or actor the note `$3` mentions
-- (`crutches[:active_mentions]`). Only followers who signed in at or after
-- `$4` count, as `followers_for_local_distribution` keeps the users who
-- signed in recently (`User.signed_in_recently`). A page lists the follows
-- after the follow id `$5` (empty for the first page), in id order, as
-- Mastodon's `find_in_batches`.
-- A unary `+` on a target column keeps SQLite seeking a block or mute by
-- the follower, whose own are few, not by the target, which every account
-- that blocks or mutes it shares (D1 keeps no `sqlite_stat1`).
SELECT f.id, f.follower_account_id, f.languages_json FROM follows f
WHERE f.target_account_id = $1 AND f.id > $5 AND f.follower_account_id != $1 AND f.kind = 'Accepted' AND f.notify != 0
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
ORDER BY f.id
LIMIT $6
