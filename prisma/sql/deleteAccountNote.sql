-- @param {String} $1:accountId
-- @param {String} $2:target
DELETE FROM account_notes
WHERE account_id = $1 AND (target_account_id = $2 OR target_actor_uri = $2)
RETURNING target_actor_uri
