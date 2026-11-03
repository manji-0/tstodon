-- @param {String} $1:ownerAccountId
-- @param {String} $2:actorUri
SELECT l.id, l.account_id, l.title, l.replies_policy, l.exclusive, l.created_at, l.updated_at
FROM account_lists l
JOIN account_list_remote_members m ON m.list_id = l.id
JOIN outbound_follows f ON f.id = m.outbound_follow_id
WHERE l.account_id = $1 AND f.actor_uri = $2
ORDER BY l.created_at DESC
