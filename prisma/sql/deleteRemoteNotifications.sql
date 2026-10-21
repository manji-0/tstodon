-- @param {String} $1:fromActorUri
-- @param {String} $2:kindsJson
-- @param {String} $3:accountId
-- @param {String} $4:statusId
DELETE FROM notifications
WHERE from_actor_uri = $1
  AND kind IN (SELECT value FROM json_each($2))
  AND ($3 = '' OR account_id = $3)
  AND ($4 = '' OR status_id = $4)
RETURNING id
