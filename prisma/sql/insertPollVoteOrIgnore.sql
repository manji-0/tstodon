-- @param {String} $1:pollId
-- @param {String} $2:accountId
-- @param {Int} $3:optionIndex
-- @param {String} $4:createdAt
INSERT OR IGNORE INTO poll_votes (poll_id, account_id, option_index, created_at)
VALUES ($1, $2, $3, $4)
