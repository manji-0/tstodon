-- @param {String} $1:seenBefore
-- @param {String} $2:select
-- @param {String} $3:jobKind
-- @param {String} $4:idsJson
-- @param {Int} $5:limit
-- The stored dead jobs a requeue names (`select` is `All`, `JobKind` or
-- `Ids`), last seen at or before `seenBefore`, oldest first.
SELECT id, body_json
FROM outbox_dead_jobs
WHERE last_seen_at <= $1
  AND ($2 = 'All'
    OR ($2 = 'JobKind' AND job_kind = $3)
    OR ($2 = 'Ids' AND id IN (SELECT value FROM json_each($4))))
ORDER BY first_seen_at, id
LIMIT $5
