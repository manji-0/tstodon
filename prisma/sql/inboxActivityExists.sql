-- @param {String} $1:activityId
SELECT activity_id
FROM inbox_activities
WHERE activity_id = $1
