-- @param {String} $1:accountId
-- @param {String} $2:actorUri
-- @param {String} $3:now
-- Whether the account still follows the actor with notifications on and
-- does not mute it, read when a queued `status` notification is sent.
SELECT 1 AS found FROM outbound_follows f
WHERE f.account_id = $1 AND f.actor_uri = $2 AND f.state = 'Accepted' AND f.notify != 0
  AND NOT EXISTS (
    SELECT 1 FROM mutes m
    WHERE m.account_id = $1 AND m.target_actor_uri = $2
      AND (m.expires_at IS NULL OR m.expires_at > $3)
  )
