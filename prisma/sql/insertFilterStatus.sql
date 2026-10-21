-- @param {String} $1:id
-- @param {String} $2:filterId
-- @param {String} $3:statusId
-- @param {String} $4:createdAt
INSERT INTO filter_statuses (id, filter_id, status_id, created_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT(filter_id, status_id) DO UPDATE SET filter_id = excluded.filter_id
RETURNING id, status_id
