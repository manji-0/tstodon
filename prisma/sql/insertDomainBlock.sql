-- @param {String} $1:id
-- @param {String} $2:domain
-- @param {String} $3:severity
-- @param {Int} $4:rejectMedia
-- @param {Int} $5:rejectReports
-- @param {Int} $6:obfuscate
-- @param {String} $7:privateComment?
-- @param {String} $8:publicComment?
-- @param {String} $9:now
INSERT INTO domain_blocks (
    id, domain, severity, reject_media, reject_reports, obfuscate, private_comment, public_comment, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
