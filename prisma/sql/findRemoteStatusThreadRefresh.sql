-- @param {String} $1:statusId
SELECT context_fetched_at, context_refreshed_at, context_refresh_count
FROM remote_statuses
WHERE id = $1
