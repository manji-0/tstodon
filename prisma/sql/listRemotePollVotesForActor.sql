-- @param {String} $1:pollId
-- @param {String} $2:actorUri
SELECT option_index FROM remote_poll_votes WHERE poll_id = $1 AND actor_uri = $2
