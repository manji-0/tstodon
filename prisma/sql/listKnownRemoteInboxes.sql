-- @param {Int} $1:limit
-- The inboxes of the remote actors this server knows, one per shared inbox,
-- those of the most recently fetched actors first. An actor on a server the
-- instance suspends, by its account domain's hostname (`host`) or its URI's
-- (`uri_host`), or by a domain above either, is left out: delivery drops its
-- inbox, so it would take a slot under `limit` for nothing.
SELECT COALESCE(shared_inbox_uri, inbox_uri) AS inbox_uri
FROM remote_actors
WHERE actor_uri NOT IN (
  SELECT actor_uri FROM remote_actor_domain_rules WHERE severity = 'suspend'
)
GROUP BY COALESCE(shared_inbox_uri, inbox_uri)
ORDER BY MAX(fetched_at) DESC
LIMIT $1
