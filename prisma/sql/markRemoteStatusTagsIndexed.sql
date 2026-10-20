-- @param {String} $1:id
UPDATE remote_statuses SET tags_indexed = 1 WHERE id = $1
