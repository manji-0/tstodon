-- @param {String} $1:statusId
-- @param {String} $2:accountId
-- A mention the note addressed them with, not a silent one that only grants access.
SELECT 1 AS ok FROM remote_status_mentions
WHERE status_id = $1 AND account_id = $2 AND silent = 0
