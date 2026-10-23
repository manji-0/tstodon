-- @param {String} $1:accessTokenId
-- @param {String} $2:alertsJson
-- @param {String} $3:policy
-- @param {String} $4:now
UPDATE push_subscriptions
  SET alerts_json = $2, policy = $3, updated_at = $4
  WHERE access_token_id = $1
RETURNING id, account_id, endpoint, p256dh, auth, standard, alerts_json, policy
