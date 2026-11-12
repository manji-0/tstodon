-- @param {String} $1:idsJson
-- The last statement of the tag backfill's page; returns the statuses this
-- run indexed.
UPDATE remote_statuses SET tags_indexed = 1
WHERE tags_indexed = 0 AND id IN (SELECT value FROM json_each($1))
RETURNING id
