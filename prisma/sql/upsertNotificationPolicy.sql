-- @param {String} $1:accountId
-- @param {String} $2:forNotFollowing
-- @param {String} $3:forNotFollowers
-- @param {String} $4:forNewAccounts
-- @param {String} $5:forPrivateMentions
-- @param {String} $6:forLimitedAccounts
-- @param {String} $7:now
INSERT INTO notification_policies (
  account_id, for_not_following, for_not_followers, for_new_accounts, for_private_mentions, for_limited_accounts, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT(account_id) DO UPDATE SET
  for_not_following = $2, for_not_followers = $3, for_new_accounts = $4,
  for_private_mentions = $5, for_limited_accounts = $6, updated_at = $7
