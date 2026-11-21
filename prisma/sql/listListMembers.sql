-- @param {String} $1:listId
-- @param {String} $2:maxId
-- @param {String} $3:sinceId
-- @param {Int} $4:limit
-- A member's cursor is its account id when local, as Mastodon pages a list's
-- accounts by account id, and its outbound follow id when remote: an `r_…`
-- account id does not sort by age.
SELECT 'LocalAccount' AS kind, member_account_id AS member, member_account_id AS cursor
FROM account_list_members
WHERE list_id = $1
  AND member_account_id > $3
  -- X'FF' is a BLOB, which sorts after every TEXT id: no max_id, no upper bound.
  AND member_account_id < COALESCE(NULLIF($2, ''), X'FF')
UNION ALL
SELECT 'RemoteActor' AS kind, f.actor_uri AS member, m.outbound_follow_id AS cursor
FROM account_list_remote_members m
JOIN outbound_follows f ON f.id = m.outbound_follow_id
WHERE m.list_id = $1
  AND m.outbound_follow_id > $3
  AND m.outbound_follow_id < COALESCE(NULLIF($2, ''), X'FF')
ORDER BY cursor DESC
LIMIT $4
