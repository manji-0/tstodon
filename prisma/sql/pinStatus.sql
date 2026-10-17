-- @param {String} $1:accountId
-- @param {String} $2:statusId
-- @param {String} $3:createdAt
INSERT INTO status_pins (account_id, status_id, created_at)
VALUES ($1, $2, $3)
ON CONFLICT(account_id, status_id) DO NOTHING
