-- @param {String} $1:like
-- @param {String} $2:suspendedHostsJson
-- @param {String} $3:allowHostsJson
-- @param {Int} $4:limit
-- @param {Int} $5:offset
-- The rows account search may list, so OFFSET counts listed accounts. Each
-- clause is a rule `searchableRemoteActors` applies: the actor is not
-- suspended; neither its account domain's hostname (`host`) nor its URI's
-- (`uri_host`) is in `suspendedDomains`; and, when there is an allow list,
-- `allowListAdmits` the authority, with or without its port, and the URI host.
SELECT actor_uri, username, domain, inbox_uri, shared_inbox_uri, public_key_id, public_key_pem, display_name, profile_json, moved_to, outbox_uri, featured_uri, followers_uri, following_uri, fetched_at
FROM remote_actors
WHERE (username LIKE $1 OR (username || '@' || domain) LIKE $1)
  AND actor_uri NOT IN (SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended')
  AND host NOT IN (SELECT value FROM json_each($2))
  AND uri_host NOT IN (SELECT value FROM json_each($2))
  AND (json_array_length($3) = 0 OR uri_host IN (SELECT value FROM json_each($3)))
  AND (json_array_length($3) = 0 OR EXISTS (
    SELECT 1 FROM json_each($3) AS allow
    WHERE allow.value = lower(domain)
      OR (substr(lower(domain), 1, length(allow.value) + 1) = allow.value || ':'
        AND length(domain) > length(allow.value) + 1
        AND substr(domain, length(allow.value) + 2) NOT GLOB '*[^0-9]*')
  ))
ORDER BY actor_uri DESC LIMIT $4 OFFSET $5
