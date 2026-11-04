-- @param {String} $1:actorUri
DELETE FROM conversation_hides
WHERE conversation_id IN (SELECT id FROM remote_statuses WHERE actor_uri = $1)
