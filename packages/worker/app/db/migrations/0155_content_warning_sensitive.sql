-- A local status with a content warning is sensitive, as Mastodon's
-- `PostStatusService` stores it whatever the request's `sensitive` says.
-- Statuses and scheduled statuses created before tstodon did so are marked
-- now; nothing is removed.
UPDATE statuses
SET sensitive = 1
WHERE kind = 'LocalNote' AND sensitive = 0 AND trim(spoiler_text) <> '';

UPDATE scheduled_statuses
SET params_json = json_set(params_json, '$.sensitive', json('true'))
WHERE json_valid(params_json)
  AND json_extract(params_json, '$.sensitive') = 0
  AND trim(coalesce(json_extract(params_json, '$.spoiler_text'), '')) <> '';
