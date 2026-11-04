-- @param {String} $1:actorUri
-- @param {Int} $2:limit
SELECT id FROM (
  SELECT id FROM remote_statuses WHERE actor_uri = $1 AND visibility <> 'direct'
  UNION ALL
  SELECT id FROM remote_boosts WHERE actor_uri = $1
) ORDER BY id DESC LIMIT $2
