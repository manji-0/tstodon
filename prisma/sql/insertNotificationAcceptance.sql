-- @param {String} $1:accountId
-- @param {String} $2:fromAccountId
-- @param {String} $3:now
INSERT INTO notification_request_acceptances (account_id, from_account_id, accepted_at)
VALUES ($1, $2, $3)
ON CONFLICT(account_id, from_account_id) DO UPDATE SET accepted_at = $3
