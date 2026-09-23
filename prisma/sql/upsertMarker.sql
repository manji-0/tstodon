-- @param {String} $1:accountId
-- @param {String} $2:timeline
-- @param {String} $3:lastReadId
-- @param {String} $4:updatedAt
INSERT INTO markers (account_id, timeline, last_read_id, version, updated_at)
VALUES ($1, $2, $3, 1, $4)
ON CONFLICT(account_id, timeline) DO UPDATE SET
  last_read_id = excluded.last_read_id,
  version = markers.version + 1,
  updated_at = excluded.updated_at
