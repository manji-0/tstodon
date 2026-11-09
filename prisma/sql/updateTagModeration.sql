-- @param {String} $1:name
-- @param {Int} $2:usable
-- @param {Int} $3:listable
-- @param {String} $4:displayName
UPDATE tags SET usable = $2, listable = $3, display_name = NULLIF($4, '') WHERE name = $1
