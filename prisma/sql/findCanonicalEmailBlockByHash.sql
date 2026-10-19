-- @param {String} $1:hash
SELECT id, canonical_email_hash, created_at FROM canonical_email_blocks WHERE canonical_email_hash = $1 LIMIT 1
