-- @param {String} $1:accountId
-- @param {String} $2:actorUrisJson
SELECT id, account_id, actor_uri, follow_activity_id, state, reblogs, notify, languages_json, created_at
FROM outbound_follows
WHERE account_id = $1 AND actor_uri IN (SELECT value FROM json_each($2))
