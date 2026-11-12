-- @param {String} $1:idsJson
-- The first statement of the tag backfill's page. Like the others, it leaves
-- a status alone once `tags_indexed` is 1: a Create or Update that landed
-- after the page was read wrote the note's own tags.
DELETE FROM remote_status_tags
WHERE status_id IN (
  SELECT s.id FROM json_each($1) e
  JOIN remote_statuses s ON s.id = e.value AND s.tags_indexed = 0
)
