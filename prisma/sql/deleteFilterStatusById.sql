-- @param {String} $1:accountId
-- @param {String} $2:id
DELETE FROM filter_statuses
  WHERE id = $2 AND filter_id IN (SELECT id FROM filters WHERE account_id = $1)
RETURNING id
