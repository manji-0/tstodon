-- @param {String} $1:actorUri
-- An admin's lifts of the actor's domain block limits (migration 0171) go with it, as the
-- limitation they lift (`purgeRemoteActorDomainLimits`).
DELETE FROM remote_actor_domain_lifts WHERE actor_uri = $1
