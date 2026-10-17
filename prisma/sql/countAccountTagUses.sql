-- @param {String} $1:accountId
-- @param {String} $2:pattern
SELECT COUNT(*) AS count, MAX(created_at) AS last_status_at FROM statuses
WHERE account_id = $1 AND kind = 'LocalNote' AND visibility = 'public' AND content_text LIKE $2
