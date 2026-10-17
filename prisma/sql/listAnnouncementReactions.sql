-- @param {String} $1:accountId
SELECT
    announcement_id,
    reaction_name,
    COUNT(*) AS count,
    MAX(CASE WHEN account_id = $1 THEN 1 ELSE 0 END) AS me
FROM account_announcement_reactions
GROUP BY announcement_id, reaction_name
