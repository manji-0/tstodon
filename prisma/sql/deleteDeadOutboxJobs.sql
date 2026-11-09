-- @param {String} $1:idsJson
DELETE FROM outbox_dead_jobs WHERE id IN (SELECT value FROM json_each($1))
