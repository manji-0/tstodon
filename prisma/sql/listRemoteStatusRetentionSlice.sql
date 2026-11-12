-- @param {String} $1:afterId
-- @param {String} $2:beforeId
-- @param {Int} $3:limit
-- The remote statuses one retention run examines: the next `$3` ids after the
-- cursor and below the cutoff's id, walked through the primary key, so a run
-- reads at most `$3` rows however large the table is.
SELECT id, actor_uri FROM remote_statuses
WHERE id > $1 AND id < $2
ORDER BY id
LIMIT $3
