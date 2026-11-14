-- @param {String} $1:idsJson
-- The local accounts each remote note mentions, in the order they were
-- stored, without the silent mentions that only grant access to the note
-- (Mastodon's `active_mentions`).
SELECT status_id, account_id FROM remote_status_mentions
WHERE status_id IN (SELECT value FROM json_each($1)) AND silent = 0
ORDER BY rowid
