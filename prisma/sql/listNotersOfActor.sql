-- @param {String} $1:targetActorUri
-- @param {String} $2:afterAccountId
-- @param {Int} $3:limit
-- @param {String} $4:movedToTarget
-- Each noter's own note on `movedToTarget` too, as findAccountNote reads it.
SELECT n.account_id, n.note,
  (SELECT t.note FROM account_notes t
   WHERE t.account_id = n.account_id
     AND (t.target_account_id = $4 OR t.target_actor_uri = $4)
   LIMIT 1) AS moved_to_note
FROM account_notes n
WHERE n.target_actor_uri = $1 AND n.account_id > $2 ORDER BY n.account_id LIMIT $3
