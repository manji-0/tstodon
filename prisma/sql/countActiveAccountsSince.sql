-- @param {String} $1:since_day
SELECT COUNT(DISTINCT account_id) AS count FROM account_activity_days WHERE day >= $1
