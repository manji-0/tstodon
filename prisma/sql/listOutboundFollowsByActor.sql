-- @param {String} $1:actorUri
-- @param {String} $2:afterId
-- @param {Int} $3:limit
SELECT id, account_id, actor_uri, follow_activity_id, state, reblogs, notify, languages_json, created_at
FROM outbound_follows WHERE actor_uri = $1 AND id > $2 ORDER BY id LIMIT $3
