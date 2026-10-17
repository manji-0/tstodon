-- @param {String} $1:id
-- @param {String} $2:statusId
-- @param {String} $3:snapshotJson
-- @param {String} $4:createdAt
INSERT INTO status_edits (id, status_id, snapshot_json, created_at)
VALUES ($1, $2, $3, $4)
