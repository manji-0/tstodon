-- @param {String} $1:activityId
-- @param {String} $2:payloadJson
-- @param {String} $3:claimedAt
-- @param {String} $4:staleBefore
-- Claim an activity id for this delivery, in one statement so concurrent
-- deliveries cannot both take it. A new id is inserted `Processing`; a
-- `Processing` claim made before `staleBefore` (an apply that never finished)
-- is taken over. Returns the row only when this delivery took the claim.
INSERT INTO inbox_activities (activity_id, kind, payload_json, created_at, state)
VALUES ($1, 'Received', $2, $3, 'Processing')
ON CONFLICT (activity_id) DO UPDATE SET
  payload_json = excluded.payload_json,
  created_at = excluded.created_at
WHERE inbox_activities.state = 'Processing' AND inbox_activities.created_at < $4
RETURNING activity_id
