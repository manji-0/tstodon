-- @param {String} $1:dueBefore
-- @param {Int} $2:limit
SELECT activity_id, inbox_url, attempt_count, created_at
FROM outbox_deliveries
WHERE kind = 'Queued' AND inbox_url IS NOT NULL
  AND COALESCE(next_attempt_at, updated_at) < $1
ORDER BY COALESCE(next_attempt_at, updated_at)
LIMIT $2
