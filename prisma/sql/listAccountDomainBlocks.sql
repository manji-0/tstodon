-- @param {String} $1:accountId
SELECT domain FROM account_domain_blocks
WHERE account_id = $1
ORDER BY created_at DESC, domain ASC
