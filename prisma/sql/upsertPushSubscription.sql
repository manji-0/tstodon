-- @param {String} $1:accountId
-- @param {String} $2:endpoint
-- @param {String} $3:p256dh
-- @param {String} $4:auth
-- @param {Int} $5:standard
-- @param {String} $6:alertsJson
-- @param {String} $7:policy
-- @param {String} $8:now
INSERT INTO push_subscriptions
  (account_id, endpoint, p256dh, auth, standard, alerts_json, policy, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
ON CONFLICT (account_id, endpoint) DO UPDATE SET
  p256dh = excluded.p256dh,
  auth = excluded.auth,
  standard = excluded.standard,
  alerts_json = excluded.alerts_json,
  policy = excluded.policy,
  updated_at = excluded.updated_at
RETURNING id, account_id, endpoint, p256dh, auth, standard, alerts_json, policy
