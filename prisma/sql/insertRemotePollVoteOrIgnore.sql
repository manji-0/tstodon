-- @param {String} $1:pollId
-- @param {String} $2:actorUri
-- @param {Int} $3:optionIndex
-- @param {String} $4:objectUri
-- @param {String} $5:createdAt
INSERT OR IGNORE INTO remote_poll_votes (poll_id, actor_uri, option_index, object_uri, created_at)
VALUES ($1, $2, $3, $4, $5)
