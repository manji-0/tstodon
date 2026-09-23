-- @param {String} $1:accountId
-- @param {String} $2:timelineA
-- @param {String} $3:timelineB
SELECT account_id, timeline, last_read_id, version, updated_at
FROM markers
WHERE account_id = $1 AND timeline IN ($2, $3)
