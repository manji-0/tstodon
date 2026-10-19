-- @param {String} $1:id
SELECT id, canonical_email_hash, created_at FROM canonical_email_blocks WHERE id = $1 LIMIT 1
