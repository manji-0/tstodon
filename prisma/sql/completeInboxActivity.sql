-- @param {String} $1:activityId
-- @param {String} $2:kind
-- Mark a claimed activity handled: applied (`kind` is its type) or rejected
-- (`kind` is the rejection's). Later deliveries of the id are duplicates.
UPDATE inbox_activities SET state = 'Processed', kind = $2
WHERE activity_id = $1
