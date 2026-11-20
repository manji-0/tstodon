-- @param {String} $1:actorUri
SELECT account_id, languages_json FROM outbound_follows
WHERE actor_uri = $1 AND state = 'Accepted' AND notify != 0
