-- @param {Int} $1:limit
-- The inboxes of the remote actors this server knows, one per shared inbox,
-- those of the most recently fetched actors first. An actor on a server the
-- instance suspends, by its account domain's hostname (`host`) or its URI's
-- (`uri_host`), is left out: delivery drops its inbox, so it would take a
-- slot under `limit` for nothing.
SELECT COALESCE(shared_inbox_uri, inbox_uri) AS inbox_uri
FROM remote_actors
WHERE host NOT IN (SELECT lower(domain) FROM domain_blocks WHERE severity = 'suspend')
  AND uri_host NOT IN (SELECT lower(domain) FROM domain_blocks WHERE severity = 'suspend')
GROUP BY COALESCE(shared_inbox_uri, inbox_uri)
ORDER BY MAX(fetched_at) DESC
LIMIT $1
