-- @param {String} $1:accountId
-- Every status the account's filters are narrowed to, each filter's in `listFilterStatuses` order.
SELECT fs.filter_id, fs.id, fs.status_id
FROM filter_statuses fs
JOIN filters f ON f.id = fs.filter_id
WHERE f.account_id = $1
ORDER BY fs.created_at, fs.id
