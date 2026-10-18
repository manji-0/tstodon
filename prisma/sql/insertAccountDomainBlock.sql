-- @param {String} $1:accountId
-- @param {String} $2:domain
-- @param {String} $3:createdAt
INSERT INTO account_domain_blocks (account_id, domain, created_at)
VALUES ($1, $2, $3)
ON CONFLICT(account_id, domain) DO NOTHING
