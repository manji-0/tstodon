-- One statement, so two concurrent removals cannot each see the other's
-- passkey and together leave the user with none.
-- @param {String} $1:id
-- @param {String} $2:userId
DELETE FROM passkey
WHERE id = $1 AND userId = $2
  AND (SELECT COUNT(*) FROM passkey WHERE userId = $2) > 1
