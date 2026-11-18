-- @param {String} $1:accountId
-- @param {String} $2:fromAccountIdsJson
-- @param {String} $3:now
INSERT INTO notification_request_acceptances (account_id, from_account_id, accepted_at)
SELECT $1, value, $3 FROM json_each($2) WHERE true
ON CONFLICT(account_id, from_account_id) DO UPDATE SET accepted_at = excluded.accepted_at
