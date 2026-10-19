-- @param {String} $1:accountId
SELECT account_id, for_not_following, for_not_followers, for_new_accounts, for_private_mentions, for_limited_accounts
FROM notification_policies WHERE account_id = $1
