-- @param {String} $1:filterId
SELECT status_id FROM filter_statuses WHERE filter_id = $1 ORDER BY created_at
