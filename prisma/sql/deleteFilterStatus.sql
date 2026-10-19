-- @param {String} $1:filterId
-- @param {String} $2:statusId
DELETE FROM filter_statuses WHERE filter_id = $1 AND status_id = $2
RETURNING status_id
