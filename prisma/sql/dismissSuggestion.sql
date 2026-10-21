-- @param {String} $1:accountId
-- @param {String} $2:targetAccountId
-- @param {String} $3:now
INSERT INTO suggestion_dismissals (account_id, target_account_id, created_at)
  VALUES ($1, $2, $3)
  ON CONFLICT (account_id, target_account_id) DO NOTHING
