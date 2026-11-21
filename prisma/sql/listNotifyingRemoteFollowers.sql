-- @param {String} $1:actorUri
-- @param {String} $2:now
-- @param {String} $3:statusId
-- @param {String} $4:activeSinceDay
-- @param {String} $5:afterFollowId
-- @param {Int} $6:limit
-- A follower who mutes the actor, notifications on or not, is left out:
-- Mastodon's `filter_from_home` filters a muted author's status. So is one
-- who blocks or mutes an account or actor the note `$3` actively mentions
-- (`crutches[:active_mentions]`): a silent mention is not an active one.
-- Only followers who made an authenticated request on or after the UTC day
-- `$4` count, as `followers_for_local_distribution` keeps the users who
-- signed in recently (`User.signed_in_recently`). A page lists the follows
-- after the follow id `$5` (empty for the first page), in id order.
-- A unary `+` on a target column keeps SQLite seeking a block or mute by
-- the follower, whose own are few, not by the target, which every account
-- that blocks or mutes it shares (D1 keeps no `sqlite_stat1`).
SELECT f.id, f.account_id, f.languages_json FROM outbound_follows f
WHERE f.actor_uri = $1 AND f.id > $5 AND f.state = 'Accepted' AND f.notify != 0
  AND EXISTS (
    SELECT 1 FROM account_activity_days d
    WHERE d.account_id = f.account_id AND d.day >= $4
  )
  AND NOT EXISTS (
    SELECT 1 FROM mutes m
    WHERE m.account_id = f.account_id AND m.target_actor_uri = $1
      AND (m.expires_at IS NULL OR m.expires_at > $2)
  )
  AND NOT EXISTS (
    SELECT 1 FROM remote_status_mentions sm
    WHERE sm.status_id = $3 AND sm.silent = 0
      AND (
        EXISTS (
          SELECT 1 FROM blocks b
          WHERE b.blocker_account_id = f.account_id AND +b.target_account_id = sm.account_id
        )
        OR EXISTS (
          SELECT 1 FROM mutes m
          WHERE m.account_id = f.account_id AND +m.target_account_id = sm.account_id
            AND (m.expires_at IS NULL OR m.expires_at > $2)
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM remote_status_remote_mentions sm
    WHERE sm.status_id = $3
      AND (
        EXISTS (
          SELECT 1 FROM blocks b
          WHERE b.blocker_account_id = f.account_id AND b.target_actor_uri = sm.actor_uri
        )
        OR EXISTS (
          SELECT 1 FROM mutes m
          WHERE m.account_id = f.account_id AND m.target_actor_uri = sm.actor_uri
            AND (m.expires_at IS NULL OR m.expires_at > $2)
        )
      )
  )
ORDER BY f.id
LIMIT $6
