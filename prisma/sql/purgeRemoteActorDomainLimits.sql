-- @param {String} $1:actorUri
-- A domain block's limitation of the actor (migration 0169) goes with it, as Mastodon destroys the
-- account that carried `silenced_at` / `suspended_at`; an actor fetched again is a new account.
DELETE FROM remote_actor_domain_limits WHERE actor_uri = $1
