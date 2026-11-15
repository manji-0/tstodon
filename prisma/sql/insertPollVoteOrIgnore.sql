-- @param {String} $1:pollId
-- @param {String} $2:accountId
-- @param {Int} $3:optionIndex
-- @param {String} $4:createdAt
-- @param {Int} $5:single
-- Nothing is written unless the poll is still open at $4, so a vote refused
-- for an ended poll leaves no row behind. With $5 = 1 (a single-choice poll)
-- nothing is written for an account that has a vote on the poll: two requests
-- that both found no earlier vote cannot each store a different option. A
-- vote for an option the account already chose is ignored by the primary key.
INSERT OR IGNORE INTO poll_votes (poll_id, account_id, option_index, created_at)
SELECT $1, $2, $3, $4
WHERE EXISTS (SELECT 1 FROM polls WHERE id = $1 AND expires_at > $4)
  AND (
    $5 = 0
    OR NOT EXISTS (SELECT 1 FROM poll_votes WHERE poll_id = $1 AND account_id = $2)
  )
