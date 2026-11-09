-- @param {String} $1:afterId
-- @param {String} $2:before
-- @param {Int} $3:limit
-- The next page of local accounts, by id after `afterId`, whose key pair was
-- not replaced since `before` (when the bulk rotation started).
SELECT id FROM accounts
WHERE id > $1 AND (key_rotated_at IS NULL OR key_rotated_at < $2)
ORDER BY id
LIMIT $3
