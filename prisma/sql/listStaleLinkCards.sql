-- @param {String} $1:before
-- @param {Int} $2:limit
SELECT url FROM link_cards
WHERE fetched_at <= $1
ORDER BY fetched_at ASC
LIMIT $2
