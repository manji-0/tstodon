-- @param {String} $1:statusId
-- @param {String} $2:accountId
-- The owner's media a status deletion removes, as Mastodon's
-- `RemoveStatusService#remove_media`: what the status holds, and what an edit
-- took off it that its edit history still shows (Mastodon keeps that attached).
-- Media an edit took off and another status now holds stays with that status.
DELETE FROM media_attachments
WHERE account_id = $2
  AND (
    status_id = $1
    OR (
      status_id IS NULL
      AND id IN (
        SELECT json_extract(j.value, '$.id')
        FROM status_edits e, json_each(e.snapshot_json, '$.media_attachments') j
        WHERE e.status_id = $1
      )
    )
  )
RETURNING object_key, legacy_object_key, preview_object_key
