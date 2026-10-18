-- @param {String} $1:accountId
-- @param {String} $2:domain
DELETE FROM account_domain_blocks WHERE account_id = $1 AND domain = $2
RETURNING domain
