-- @param {String} $1:term
-- @param {String} $2:allowHostsJson
-- @param {Int} $3:limit
-- @param {Int} $4:offset
-- The rows account search may list, so OFFSET counts listed accounts. Each
-- clause is a rule `searchableRemoteActors` applies: the actor is not
-- suspended; neither its account domain's hostname (`host`) nor its URI's
-- (`uri_host`) is suspended, by itself or a domain above it, as
-- `suspendedDomains` matches them; and, when there is an allow list,
-- `allowListAdmits` the authority, with or without its port, and the URI host.
SELECT actor_uri, username, domain, inbox_uri, shared_inbox_uri, display_name, profile_json, moved_to, outbox_uri, featured_uri, featured_tags_uri, followers_uri, following_uri, fetched_at
FROM remote_actors
WHERE instr(lower(username || '@' || domain), lower($1)) > 0
  AND actor_uri NOT IN (SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended')
  AND actor_uri NOT IN (
    SELECT actor_uri FROM remote_actor_domain_rules WHERE severity = 'suspend'
  )
  AND (json_array_length($2) = 0 OR uri_host IN (SELECT value FROM json_each($2)))
  AND (json_array_length($2) = 0 OR EXISTS (
    SELECT 1 FROM json_each($2) AS allow
    WHERE allow.value = lower(domain)
      OR (substr(lower(domain), 1, length(allow.value) + 1) = allow.value || ':'
        AND length(domain) > length(allow.value) + 1
        AND substr(domain, length(allow.value) + 2) NOT GLOB '*[^0-9]*')
  ))
ORDER BY actor_uri DESC LIMIT $3 OFFSET $4
