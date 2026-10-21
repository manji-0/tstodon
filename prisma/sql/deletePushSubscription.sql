-- @param {Int} $1:id
DELETE FROM push_subscriptions WHERE id = $1
RETURNING id
