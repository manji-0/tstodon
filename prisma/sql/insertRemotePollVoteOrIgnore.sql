-- @param {String} $1:pollId
-- @param {String} $2:actorUri
-- @param {Int} $3:optionIndex
-- @param {String} $4:objectUri
-- @param {String} $5:createdAt
-- Nothing is written unless the poll is still open at $5, so a vote refused
-- for an ended poll leaves no row behind.
INSERT OR IGNORE INTO remote_poll_votes (poll_id, actor_uri, option_index, object_uri, created_at)
SELECT $1, $2, $3, $4, $5
WHERE EXISTS (SELECT 1 FROM polls WHERE id = $1 AND expires_at > $5)
