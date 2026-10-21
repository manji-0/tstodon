-- @param {String} $1:accountId
SELECT id, account_id, endpoint, p256dh, auth, standard, alerts_json, policy
  FROM push_subscriptions
  WHERE account_id = $1
  ORDER BY updated_at DESC, id DESC
  LIMIT 1
