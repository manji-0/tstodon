-- @param {String} $1:name
SELECT name, usable, listable, display_name FROM tags WHERE name = $1 LIMIT 1
