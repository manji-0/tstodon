-- @param {String} $1:id
-- @param {String} $2:statusId
-- @param {String} $3:snapshotJson
-- @param {String} $4:createdAt
-- @param {String} $5:expectedEditedAt?
-- The snapshot is of the version last edited at $5 (NULL: never edited, which
-- an empty edited_at reads as too). When the row holds another version by
-- now, status_id is NULL, so the NOT NULL constraint fails and the batch this
-- runs in is rolled back: the snapshot is not kept twice, and the version
-- stored since is not replaced unrecorded.
INSERT INTO remote_status_edits (id, status_id, snapshot_json, created_at)
SELECT $1, CASE WHEN NULLIF(edited_at, '') IS $5 THEN id END, $3, $4
FROM remote_statuses
WHERE id = $2
