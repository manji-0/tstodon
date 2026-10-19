-- @param {String} $1:domain
-- @param {String} $2:since
SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS accounts
FROM accounts
WHERE substr(access_email, instr(access_email, '@') + 1) = $1 AND created_at >= $2
GROUP BY day
