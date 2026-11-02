-- @param {String} $1:statusId
-- @param {String} $2:accountId
-- @param {Int} $3:choiceIndex
-- @param {String} $4:activityId
-- @param {String} $5:createdAt
INSERT OR IGNORE INTO remote_poll_own_votes (status_id, account_id, choice_index, activity_id, created_at)
VALUES ($1, $2, $3, $4, $5)
