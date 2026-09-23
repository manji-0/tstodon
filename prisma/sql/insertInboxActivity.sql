-- @param {String} $1:activityId
-- @param {String} $2:kind
-- @param {String} $3:payloadJson
-- @param {String} $4:createdAt
INSERT OR IGNORE INTO inbox_activities (activity_id, kind, payload_json, created_at)
VALUES ($1, $2, $3, $4)
