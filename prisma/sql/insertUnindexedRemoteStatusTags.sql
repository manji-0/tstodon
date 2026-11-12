-- @param {String} $1:entriesJson
-- Indexes a page of remote statuses under their tags in one statement:
-- `entriesJson` is `[[statusId, [tag, ...]], ...]`. Only a status still
-- `tags_indexed = 0` is written (see `deleteUnindexedRemoteStatusTags`).
INSERT OR IGNORE INTO remote_status_tags (status_id, tag)
SELECT s.id, t.value
FROM json_each($1) e
JOIN remote_statuses s
  ON s.id = json_extract(e.value, '$[0]') AND s.tags_indexed = 0
JOIN json_each(json_extract(e.value, '$[1]')) t
ORDER BY e.key, t.key
