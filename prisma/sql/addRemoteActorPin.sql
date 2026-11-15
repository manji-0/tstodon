-- @param {String} $1:actorUri
-- @param {String} $2:statusId
-- A new pin goes first, as Mastodon lists the newest pin first.
INSERT INTO remote_actor_pins (actor_uri, status_id, position)
VALUES ($1, $2, (SELECT COALESCE(MIN(position), 0) - 1 FROM remote_actor_pins WHERE actor_uri = $1))
ON CONFLICT(actor_uri, status_id) DO NOTHING
