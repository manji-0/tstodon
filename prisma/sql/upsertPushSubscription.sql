-- @param {String} $1:accessTokenId
-- @param {String} $2:accountId
-- @param {String} $3:endpoint
-- @param {String} $4:p256dh
-- @param {String} $5:auth
-- @param {Int} $6:standard
-- @param {String} $7:alertsJson
-- @param {String} $8:policy
-- @param {String} $9:now
INSERT OR REPLACE INTO push_subscriptions
  (access_token_id, account_id, endpoint, p256dh, auth, standard, alerts_json, policy, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
RETURNING id, account_id, endpoint, p256dh, auth, standard, alerts_json, policy
