-- @param {String} $1:hostKeyFrom
-- @param {String} $2:hostKeyTo
-- @param {String} $3:now
UPDATE remote_statuses SET media_json = '[]', updated_at = $3
-- The actors on the domain or a subdomain of it (`hostKeyRange`), by their
-- account domain or the host of their URI, as `by_domain_and_subdomains`.
WHERE actor_uri IN (
  SELECT actor_uri FROM remote_actors WHERE host_key >= $1 AND host_key < $2
  UNION
  SELECT actor_uri FROM remote_actors WHERE uri_host_key >= $1 AND uri_host_key < $2
)
