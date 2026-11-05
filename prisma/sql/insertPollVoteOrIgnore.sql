-- @param {String} $1:pollId
-- @param {String} $2:accountId
-- @param {Int} $3:optionIndex
-- @param {String} $4:createdAt
-- Nothing is written unless the poll is still open at $4, so a vote refused
-- for an ended poll leaves no row behind.
INSERT OR IGNORE INTO poll_votes (poll_id, account_id, option_index, created_at)
SELECT $1, $2, $3, $4
WHERE EXISTS (SELECT 1 FROM polls WHERE id = $1 AND expires_at > $4)
