-- @param {String} $1:statusId
-- @param {String} $2:authorId
-- @param {Int} $3:ownReplies
-- @param {String} $4:afterId
-- @param {Int} $5:limit
-- The public and unlisted local replies to a local note, oldest first after
-- `afterId` ('' for the first page): the author's own with `ownReplies` 1,
-- those of other accounts that are not suspended with 0.
SELECT s.id, a.username
FROM statuses s
JOIN accounts a ON a.id = s.account_id
WHERE s.in_reply_to_id = $1 AND s.kind = 'LocalNote'
  AND s.visibility IN ('public', 'unlisted')
  AND s.id > $4
  AND (
    ($3 = 1 AND s.account_id = $2)
    OR (
      $3 = 0 AND s.account_id <> $2
      AND s.account_id NOT IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')
    )
  )
ORDER BY s.id
LIMIT $5
