-- @param {String} $1:statusId
-- @param {String} $2:expectedEditedAt?
-- Fails the batch it runs in when the row no longer holds the version last
-- edited at $2 (NULL: never edited, which an empty edited_at reads as too):
-- the row it then selects has no status_id, which the NOT NULL constraint
-- refuses. It writes nothing when the version is the expected one, or when
-- the row is gone.
INSERT INTO remote_status_edits (id, status_id, snapshot_json, created_at)
SELECT 'refused', NULL, '', ''
FROM remote_statuses
WHERE id = $1 AND NULLIF(edited_at, '') IS NOT $2
