-- @param {String} $1:statusId
-- @param {String} $2:actorUri
-- Whether a local note mentions the remote actor, silently or not: what
-- Mastodon's `StatusPolicy#mention_exists?` reads.
SELECT 1 AS found FROM status_remote_mentions WHERE status_id = $1 AND actor_uri = $2
