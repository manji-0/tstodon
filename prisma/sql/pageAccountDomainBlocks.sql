-- @param {String} $1:accountId
-- @param {String} $2:maxId
-- @param {String} $3:sinceId
-- @param {Int} $4:limit
SELECT id, domain FROM account_domain_blocks
WHERE account_id = $1
  AND id > $3
  -- X'FF' is a BLOB, which sorts after every TEXT id: no max_id, no upper bound.
  AND id < COALESCE(NULLIF($2, ''), X'FF')
ORDER BY id DESC
LIMIT $4
