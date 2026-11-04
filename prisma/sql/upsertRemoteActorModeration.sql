-- @param {String} $1:actorUri
-- @param {String} $2:moderation?
-- @param {Int} $3:sensitized
-- @param {String} $4:now
INSERT INTO remote_actor_moderation (actor_uri, moderation, sensitized, created_at, updated_at)
VALUES ($1, $2, $3, $4, $4)
ON CONFLICT(actor_uri) DO UPDATE SET moderation = $2, sensitized = $3, updated_at = $4
