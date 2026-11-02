-- @param {String} $1:actorUri
DELETE FROM notification_dismissals
WHERE notification_id IN (SELECT id FROM notifications WHERE from_actor_uri = $1)
