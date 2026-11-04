-- @param {String} $1:actorUri
DELETE FROM status_mutes
WHERE thread_root_status_id IN (SELECT id FROM remote_statuses WHERE actor_uri = $1)
