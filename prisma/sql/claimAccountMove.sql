-- @param {String} $1:accountId
-- @param {String} $2:acct
-- @param {String} $3:targetUri
-- @param {String} $4:movedAt
-- @param {String} $5:cooldownStartedBefore
INSERT INTO account_moves (account_id, acct, target_uri, moved_at) VALUES ($1, $2, $3, $4)
ON CONFLICT (account_id) DO UPDATE SET
  acct = excluded.acct,
  target_uri = excluded.target_uri,
  moved_at = CASE
    WHEN account_moves.target_uri = excluded.target_uri AND account_moves.cancelled_at IS NULL
    THEN account_moves.moved_at ELSE excluded.moved_at END,
  cancelled_at = NULL
WHERE (account_moves.target_uri = excluded.target_uri AND account_moves.cancelled_at IS NULL)
  OR account_moves.moved_at <= $5
RETURNING account_id
