-- @param {String} $1:accountId
-- @param {String} $2:announcementId
-- @param {String} $3:reactionName
-- @param {String} $4:now
INSERT INTO account_announcement_reactions (account_id, announcement_id, reaction_name, created_at, updated_at)
VALUES ($1, $2, $3, $4, $4)
ON CONFLICT(account_id, announcement_id, reaction_name) DO UPDATE SET updated_at = $4
