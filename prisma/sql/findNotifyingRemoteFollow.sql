-- @param {String} $1:accountId
-- @param {String} $2:actorUri
-- @param {String} $3:now
-- @param {String} $4:statusId
-- Whether the account still follows the actor with notifications on, does
-- not mute it, and does not block or mute an account or actor the note `$4`
-- actively mentions, read when a queued `status` notification is sent, as
-- `FeedInsertWorker` runs `filter_from_home` when it runs.
-- A unary `+` on a target column keeps SQLite seeking a block or mute by
-- the follower, whose own are few, not by the target, which every account
-- that blocks or mutes it shares (D1 keeps no `sqlite_stat1`).
SELECT 1 AS found FROM outbound_follows f
WHERE f.account_id = $1 AND f.actor_uri = $2 AND f.state = 'Accepted' AND f.notify != 0
  AND NOT EXISTS (
    SELECT 1 FROM mutes m
    WHERE m.account_id = $1 AND m.target_actor_uri = $2
      AND (m.expires_at IS NULL OR m.expires_at > $3)
  )
  AND NOT EXISTS (
    SELECT 1 FROM remote_status_mentions sm
    WHERE sm.status_id = $4 AND sm.silent = 0
      AND (
        EXISTS (
          SELECT 1 FROM blocks b
          WHERE b.blocker_account_id = $1 AND +b.target_account_id = sm.account_id
        )
        OR EXISTS (
          SELECT 1 FROM mutes m
          WHERE m.account_id = $1 AND +m.target_account_id = sm.account_id
            AND (m.expires_at IS NULL OR m.expires_at > $3)
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM remote_status_remote_mentions sm
    WHERE sm.status_id = $4
      AND (
        EXISTS (
          SELECT 1 FROM blocks b
          WHERE b.blocker_account_id = $1 AND b.target_actor_uri = sm.actor_uri
        )
        OR EXISTS (
          SELECT 1 FROM mutes m
          WHERE m.account_id = $1 AND m.target_actor_uri = sm.actor_uri
            AND (m.expires_at IS NULL OR m.expires_at > $3)
        )
      )
  )
