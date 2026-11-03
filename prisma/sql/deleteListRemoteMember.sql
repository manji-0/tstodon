-- @param {String} $1:listId
-- @param {String} $2:actorUri
DELETE FROM account_list_remote_members
WHERE list_id = $1
  AND outbound_follow_id IN (SELECT id FROM outbound_follows WHERE actor_uri = $2)
