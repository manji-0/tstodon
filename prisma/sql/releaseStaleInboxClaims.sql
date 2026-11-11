-- @param {String} $1:staleBefore
-- @param {Int} $2:limit
-- Up to `limit` of the claims made before `staleBefore` and never finished:
-- the Worker applying them was cut off. Deleting one lets a redelivery apply
-- the activity. The WHERE term matches `idx_inbox_activities_processing`.
DELETE FROM inbox_activities
WHERE activity_id IN (
    SELECT activity_id FROM inbox_activities
    WHERE state = 'Processing'
      AND created_at < $1
    ORDER BY created_at
    LIMIT $2
  )
