-- @param {Int} $1:limit
-- The inboxes of the remote actors this server knows, one per shared inbox,
-- those of the most recently fetched actors first.
SELECT COALESCE(shared_inbox_uri, inbox_uri) AS inbox_uri
FROM remote_actors
GROUP BY COALESCE(shared_inbox_uri, inbox_uri)
ORDER BY MAX(fetched_at) DESC
LIMIT $1
