-- @param {String} $1:activityId
SELECT state FROM inbox_activities WHERE activity_id = $1
