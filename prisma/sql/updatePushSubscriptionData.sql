-- @param {String} $1:accountId
-- @param {Int} $2:id
-- @param {String} $3:alertsJson
-- @param {String} $4:policy
-- @param {String} $5:now
UPDATE push_subscriptions
  SET alerts_json = $3, policy = $4, updated_at = $5
  WHERE account_id = $1 AND id = $2
RETURNING id, account_id, endpoint, p256dh, auth, standard, alerts_json, policy
