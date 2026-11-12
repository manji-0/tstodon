-- @param {String} $1:entriesJson
-- Stores the tag names of a page of remote statuses for hashtag search:
-- `entriesJson` is `[[statusId, [tag, ...]], ...]`, the statuses anyone can
-- read. Only a status still `tags_indexed = 0` counts (see
-- `deleteUnindexedRemoteStatusTags`).
INSERT OR IGNORE INTO tags (name)
SELECT DISTINCT t.value
FROM json_each($1) e
JOIN remote_statuses s
  ON s.id = json_extract(e.value, '$[0]') AND s.tags_indexed = 0
JOIN json_each(json_extract(e.value, '$[1]')) t
