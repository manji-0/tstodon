-- @param {String} $1:actorUri
-- An admin's lifts of the actor's domain block limits go with it, as the
-- limitation they lift (`purgeRemoteActorDomainLimits`).
DELETE FROM remote_actor_domain_lifts WHERE actor_uri = $1
