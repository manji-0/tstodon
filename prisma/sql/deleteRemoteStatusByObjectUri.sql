-- @param {String} $1:objectUri
DELETE FROM remote_statuses WHERE object_uri = $1
RETURNING id
