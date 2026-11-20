-- @param {String} $1:objectUrisJson
-- Which of the given object URIs name a cached remote status.
SELECT object_uri FROM remote_statuses
WHERE object_uri IN (SELECT value FROM json_each($1))
