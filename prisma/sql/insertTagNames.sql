-- @param {String} $1:namesJson
INSERT OR IGNORE INTO tags (name) SELECT value FROM json_each($1)
