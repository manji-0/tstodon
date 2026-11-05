-- @param {String} $1:fromActorUri
-- @param {String} $2:kindsJson
-- @param {String} $3:statusId
DELETE FROM notifications
WHERE from_actor_uri = $1
  AND kind IN (SELECT value FROM json_each($2))
  AND status_id = $3
RETURNING id
