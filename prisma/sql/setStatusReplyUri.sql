-- @param {String} $1:statusId
-- @param {String} $2:inReplyToUri
-- @param {String} $3:parentActorUri
-- A local reply to a remote status answers that status's author.
UPDATE statuses
SET in_reply_to_uri = $2, in_reply_to_account_id = NULL, in_reply_to_actor_uri = $3
WHERE id = $1
