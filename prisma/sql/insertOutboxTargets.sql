-- @param {String} $1:activityId
-- @param {String} $2:targetsJson
-- @param {String} $3:createdAt
-- The targets of an activity in one statement, whatever their number:
-- `targetsJson` is an array of `[id, inboxUrl, kind, reasonKind]`, with a
-- null `reasonKind` for a `Queued` target. A target already there keeps its
-- state.
INSERT OR IGNORE INTO outbox_deliveries
 (id, activity_id, kind, reason_kind, attempt_count, inbox_url, created_at, updated_at)
SELECT json_extract(value, '$[0]'), $1, json_extract(value, '$[2]'),
       json_extract(value, '$[3]'), 0, json_extract(value, '$[1]'), $3, $3
FROM json_each($2)
