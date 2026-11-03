-- @param {String} $1:activityId
-- @param {String} $2:actorUri
DELETE FROM remote_boosts WHERE activity_id = $1 AND actor_uri = $2
