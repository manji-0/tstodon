-- @param {String} $1:statusId
-- @param {String} $2:accountIdsJson
-- A real mention promotes a silent one, as Mastodon sets `mentions.silent`
-- to false. One statement however many accounts, in the order the note names them.
INSERT INTO status_mentions (status_id, account_id, silent)
SELECT $1, value, 0 FROM json_each($2) WHERE true ORDER BY key
ON CONFLICT(status_id, account_id) DO UPDATE SET silent = 0
