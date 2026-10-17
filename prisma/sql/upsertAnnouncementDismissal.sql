-- @param {String} $1:accountId
-- @param {String} $2:announcementId
-- @param {String} $3:now
INSERT INTO account_announcement_dismissals (account_id, announcement_id, created_at, updated_at)
VALUES ($1, $2, $3, $3)
ON CONFLICT(account_id, announcement_id) DO UPDATE SET updated_at = $3
