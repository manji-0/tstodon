-- @param {String} $1:accountId
-- @param {String} $2:actorUri
-- The account's block on the actor's account domain (`remote_actors.host`), as Mastodon matches `account.domain`; none for an actor not cached.
SELECT domain FROM account_domain_blocks
WHERE account_id = $1
  AND domain = (SELECT host FROM remote_actors WHERE actor_uri = $2)
LIMIT 1
