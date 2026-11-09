-- @param {String} $1:prefix
-- @param {Int} $2:limit
-- @param {Int} $3:offset
-- Names that start with `prefix`, as a range on the primary key: U+10FFFF
-- sorts after every character a name can hold. A tag an admin made unusable
-- or unlisted is not offered.
SELECT name FROM tags
WHERE name >= $1 AND name < $1 || char(1114111) AND usable <> 0 AND listable <> 0
ORDER BY length(name), name
LIMIT $2 OFFSET $3
