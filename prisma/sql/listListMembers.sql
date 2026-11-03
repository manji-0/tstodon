-- @param {String} $1:listId
SELECT 'LocalAccount' AS kind, member_account_id AS member, created_at
FROM account_list_members
WHERE list_id = $1
UNION ALL
SELECT 'RemoteActor' AS kind, f.actor_uri AS member, m.created_at
FROM account_list_remote_members m
JOIN outbound_follows f ON f.id = m.outbound_follow_id
WHERE m.list_id = $1
ORDER BY created_at ASC
