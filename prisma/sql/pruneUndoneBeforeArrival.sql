-- @param {String} $1:createdBefore
-- @param {Int} $2:limit
-- Delete up to `limit` remembered `Undo`s made before `createdBefore`.
DELETE FROM undone_before_arrival
WHERE rowid IN (
    SELECT rowid FROM undone_before_arrival
    WHERE created_at < $1
    ORDER BY created_at
    LIMIT $2
  )
