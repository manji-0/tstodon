-- @param {String} $1:accountId
-- @param {String} $2:domain
SELECT domain FROM account_domain_blocks
WHERE account_id = $1 AND domain = $2
LIMIT 1
