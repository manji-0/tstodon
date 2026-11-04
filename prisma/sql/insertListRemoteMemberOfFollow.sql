-- @param {String} $1:listId
-- @param {String} $2:ownerAccountId
-- @param {String} $3:actorUri
-- @param {String} $4:createdAt
INSERT OR IGNORE INTO account_list_remote_members (list_id, outbound_follow_id, created_at)
SELECT $1, f.id, $4 FROM outbound_follows f
WHERE f.account_id = $2 AND f.actor_uri = $3
