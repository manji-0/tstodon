-- @param {String} $1:id
-- @param {String} $2:severity
-- @param {Int} $3:rejectMedia
-- @param {Int} $4:rejectReports
-- @param {Int} $5:obfuscate
-- @param {String} $6:privateComment?
-- @param {String} $7:publicComment?
-- @param {String} $8:now
UPDATE domain_blocks
SET severity = $2, reject_media = $3, reject_reports = $4, obfuscate = $5,
    private_comment = $6, public_comment = $7, updated_at = $8
WHERE id = $1
RETURNING id
