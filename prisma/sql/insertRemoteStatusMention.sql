-- @param {String} $1:statusId
-- @param {String} $2:accountId
-- A real mention promotes a silent one, as Mastodon upserts `mentions.silent`.
INSERT INTO remote_status_mentions (status_id, account_id, silent)
VALUES ($1, $2, 0)
ON CONFLICT(status_id, account_id) DO UPDATE SET silent = 0
