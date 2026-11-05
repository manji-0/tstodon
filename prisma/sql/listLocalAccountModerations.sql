-- @param {String} $1:idsJson
SELECT a.id AS account_id, m.moderation, COALESCE(f.sensitized, 0) AS sensitized,
  COALESCE(f.pending, 0) AS pending, COALESCE(f.disabled, 0) AS disabled
FROM accounts a
LEFT JOIN account_moderation m ON m.account_id = a.id
LEFT JOIN account_flags f ON f.account_id = a.id
WHERE a.id IN (SELECT value FROM json_each($1))
