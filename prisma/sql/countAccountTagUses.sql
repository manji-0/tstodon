-- @param {String} $1:accountId
-- @param {String} $2:tag
SELECT COUNT(*) AS count, MAX(s.created_at) AS last_status_at FROM local_status_tags t
JOIN statuses s ON s.id = t.status_id
WHERE t.tag = $2 AND s.account_id = $1 AND s.kind = 'LocalNote' AND s.visibility = 'public'
