-- @param {String} $1:actorUri
DELETE FROM account_notes WHERE target_actor_uri = $1
