-- @param {String} $1:accessTokenId
SELECT id, account_id, endpoint, p256dh, auth, standard, alerts_json, policy
  FROM push_subscriptions
  WHERE access_token_id = $1
