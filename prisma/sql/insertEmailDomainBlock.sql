-- @param {String} $1:id
-- @param {String} $2:domain
-- @param {String} $3:createdAt
INSERT INTO email_domain_blocks (id, domain, created_at) VALUES ($1, $2, $3)
