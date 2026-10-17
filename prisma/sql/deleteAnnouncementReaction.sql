-- @param {String} $1:accountId
-- @param {String} $2:announcementId
-- @param {String} $3:reactionName
DELETE FROM account_announcement_reactions
WHERE account_id = $1 AND announcement_id = $2 AND reaction_name = $3
RETURNING reaction_name
