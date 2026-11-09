-- @param {String} $1:namesJson
SELECT name, usable, listable, display_name FROM tags
WHERE name IN (SELECT value FROM json_each($1))
