-- @param {String} $1:idsJson
-- The replies among the local statuses `idsJson` names: the remote parent's
-- URI, if the parent is remote, and whom each answers. A reply whose parent
-- was deleted (`in_reply_to_id` set to NULL) keeps the account it stored.
SELECT id, in_reply_to_uri, in_reply_to_account_id, in_reply_to_actor_uri FROM statuses
WHERE id IN (SELECT value FROM json_each($1))
  AND (in_reply_to_id IS NOT NULL OR in_reply_to_uri IS NOT NULL
    OR in_reply_to_account_id IS NOT NULL OR in_reply_to_actor_uri IS NOT NULL)
