-- @param {String} $1:accountId
-- @param {String} $2:id
SELECT fs.id, fs.status_id FROM filter_statuses fs
  JOIN filters f ON f.id = fs.filter_id
  WHERE f.account_id = $1 AND fs.id = $2
