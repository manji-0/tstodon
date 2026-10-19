-- @param {String} $1:filterId
-- @param {String} $2:statusId
-- @param {String} $3:createdAt
INSERT INTO filter_statuses (filter_id, status_id, created_at)
VALUES ($1, $2, $3)
ON CONFLICT(filter_id, status_id) DO NOTHING
