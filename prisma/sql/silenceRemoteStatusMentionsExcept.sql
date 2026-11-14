-- @param {String} $1:statusId
-- @param {String} $2:mentionedIdsJson
-- A real mention the note no longer carries becomes silent, as Mastodon's
-- `ProcessStatusUpdateService#update_mentions!`: the account keeps its access
-- to the note and leaves its mentions.
UPDATE remote_status_mentions SET silent = 1
WHERE status_id = $1 AND silent = 0
  AND account_id NOT IN (SELECT value FROM json_each($2))
