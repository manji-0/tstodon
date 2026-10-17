-- @param {String} $1:accountId
-- @param {String} $2:targetAccountId?
-- @param {String} $3:targetActorUri
-- @param {Int} $4:notifications
-- @param {String} $5:expiresAt?
-- @param {String} $6:createdAt
INSERT INTO mutes (account_id, target_account_id, target_actor_uri, notifications, expires_at, created_at)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT(account_id, target_actor_uri) DO UPDATE SET
  target_account_id = excluded.target_account_id,
  notifications = excluded.notifications,
  expires_at = excluded.expires_at
