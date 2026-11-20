-- @param {String} $1:actorUri
-- @param {String} $2:now
-- A follower who mutes the actor, notifications on or not, is left out:
-- Mastodon's `filter_from_home` filters a muted author's status.
SELECT f.account_id, f.languages_json FROM outbound_follows f
WHERE f.actor_uri = $1 AND f.state = 'Accepted' AND f.notify != 0
  AND NOT EXISTS (
    SELECT 1 FROM mutes m
    WHERE m.account_id = f.account_id AND m.target_actor_uri = $1
      AND (m.expires_at IS NULL OR m.expires_at > $2)
  )
