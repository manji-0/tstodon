-- @param {String} $1:accountId
-- @param {String} $2:actorUri
-- The account's block on either host of the actor: its account domain (`host`) or its URI's (`uri_host`), as an instance rule matches; none for an actor not cached.
SELECT domain FROM account_domain_blocks
WHERE account_id = $1
  AND domain IN (
    SELECT host FROM remote_actors WHERE actor_uri = $2
    UNION ALL
    SELECT uri_host FROM remote_actors WHERE actor_uri = $2
  )
LIMIT 1
