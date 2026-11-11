-- @param {String} $1:activityId
-- Give up a claim whose apply failed, so the sender's retry claims it again.
-- A `Processed` row stays.
DELETE FROM inbox_activities
WHERE activity_id = $1 AND state = 'Processing'
