-- @param {String} $1:statusId
-- @param {String} $2:mentionedUrisJson
-- A remote actor a local note's edit no longer mentions keeps a silent
-- mention, as Mastodon's `ProcessMentionsService#assign_mentions!`.
UPDATE status_remote_mentions SET silent = 1
WHERE status_id = $1 AND silent = 0
  AND actor_uri NOT IN (SELECT value FROM json_each($2))
