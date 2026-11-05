-- @param {String} $1:id
-- @param {String} $2:fromKey
-- @param {String} $3:toKey
-- Every snapshot of the owner's statuses that names the old key, including
-- revisions of a status an edit later removed the media from.
UPDATE status_edits
SET snapshot_json = replace(snapshot_json, '/' || $2 || '"', '/' || $3 || '"')
WHERE status_id IN (
    SELECT s.id FROM statuses s
    WHERE s.account_id = (SELECT account_id FROM media_attachments WHERE id = $1)
  )
  AND instr(snapshot_json, '/' || $2 || '"') > 0
