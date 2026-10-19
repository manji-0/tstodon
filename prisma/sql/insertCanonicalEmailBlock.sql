-- @param {String} $1:id
-- @param {String} $2:hash
-- @param {String} $3:createdAt
INSERT INTO canonical_email_blocks (id, canonical_email_hash, created_at) VALUES ($1, $2, $3)
