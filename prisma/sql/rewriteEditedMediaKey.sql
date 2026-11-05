-- @param {String} $1:id
-- @param {String} $2:fromKey
-- @param {String} $3:toKey
UPDATE status_edits
SET snapshot_json = replace(snapshot_json, '/' || $2 || '"', '/' || $3 || '"')
WHERE status_id = (
    SELECT status_id FROM media_attachments WHERE id = $1 AND object_key = $3
)
