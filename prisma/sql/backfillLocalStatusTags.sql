-- @param {String} $1:entriesJson
-- Indexes a page of local notes under their tags in one statement:
-- `entriesJson` is `[[statusId, contentText, [tag, ...]], ...]`. A note is
-- indexed only while its text is still the one its tags were read from, so
-- an edit that landed after the page was read (and indexed the new text
-- itself) does not get the old tags back; nor does a deleted note.
INSERT OR IGNORE INTO local_status_tags (status_id, tag)
SELECT s.id, t.value
FROM json_each($1) e
JOIN statuses s
  ON s.id = json_extract(e.value, '$[0]')
  AND s.kind = 'LocalNote'
  AND s.content_text = json_extract(e.value, '$[1]')
JOIN json_each(json_extract(e.value, '$[2]')) t
