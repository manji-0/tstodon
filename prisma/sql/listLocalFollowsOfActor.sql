-- @param {String} $1:actorUri
-- Every local account's follow of the actor, accepted or requested, with the
-- account's username.
SELECT f.account_id, a.username, f.state, f.follow_activity_id
FROM outbound_follows f
JOIN accounts a ON a.id = f.account_id
WHERE f.actor_uri = $1
