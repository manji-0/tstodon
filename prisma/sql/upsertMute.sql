-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:targetAccountId?
-- @param {String} $4:targetActorUri
-- @param {Int} $5:notifications
-- @param {String} $6:expiresAt?
-- @param {String} $7:createdAt
INSERT INTO mutes (id, account_id, target_account_id, target_actor_uri, notifications, expires_at, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT(account_id, target_actor_uri) DO UPDATE SET
  target_account_id = excluded.target_account_id,
  notifications = excluded.notifications,
  expires_at = excluded.expires_at
