-- @param {String} $1:listId
-- @param {String} $2:actorUri
-- @param {String} $3:createdAt
INSERT OR IGNORE INTO account_list_remote_members (list_id, outbound_follow_id, created_at)
SELECT l.id, f.id, $3
FROM account_lists l
JOIN outbound_follows f ON f.account_id = l.account_id
WHERE l.id = $1 AND f.actor_uri = $2 AND f.state = 'Accepted'
