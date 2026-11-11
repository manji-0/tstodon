-- @param {String} $1:statusId
-- @param {String} $2:accountId
-- @param {String} $3:tagsJson
-- Indexes a local note under these tags. Nothing is written when the account
-- owns no such note, so an edit's or a backfill's batch cannot index a note
-- that is another's or was deleted meanwhile.
INSERT OR IGNORE INTO local_status_tags (status_id, tag)
SELECT s.id, j.value FROM statuses s, json_each($3) j
WHERE s.id = $1 AND s.account_id = $2 AND s.kind = 'LocalNote'
