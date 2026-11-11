-- @param {String} $1:statusId
-- @param {Int} $2:resultCount
UPDATE remote_statuses
SET context_refreshed_at = context_fetched_at, context_refresh_count = $2
WHERE id = $1
