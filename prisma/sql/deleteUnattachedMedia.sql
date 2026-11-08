-- @param {String} $1:createdBefore
-- @param {Int} $2:limit
-- Up to `limit` of the oldest media no status holds, uploaded before
-- `createdBefore`, as Mastodon's `Vacuum::MediaAttachmentsVacuum` removes
-- them. Media a scheduled post names is kept (Mastodon's `unattached` scope
-- also requires no `scheduled_status_id`), and so is media an edit took off a
-- status whose edit history still shows it (Mastodon keeps that attached).
DELETE FROM media_attachments
WHERE id IN (
    SELECT m.id FROM media_attachments m
    WHERE m.status_id IS NULL
      AND m.created_at < $1
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_statuses s, json_each(s.params_json, '$.media_ids') j
        WHERE s.account_id = m.account_id AND j.value = m.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM statuses st
        JOIN status_edits e ON e.status_id = st.id,
        json_each(e.snapshot_json, '$.media_attachments') j
        WHERE st.account_id = m.account_id AND json_extract(j.value, '$.id') = m.id
      )
    ORDER BY m.created_at
    LIMIT $2
  )
RETURNING object_key, legacy_object_key, preview_object_key
