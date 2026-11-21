-- Who a reply answers, Mastodon v4.7.5's `in_reply_to_account_id`: a local
-- account id or a remote actor URI, at most one of them set. It is set when
-- the reply is linked to its parent and not computed again
-- (`Status#set_conversation`, `carried_over_reply_to_account_id`): a reply
-- to its author's own reply takes that reply's, any other the parent's
-- author. Both are NULL for a status that is no reply, and for a reply whose
-- parent was not held when it was linked, or whose parent had none to carry.
--
-- A local note sets them when it is published (`insertLocalNote.sql`,
-- `setStatusReplyUri.sql`), a remote note when it is stored
-- (`insertRemoteStatus.sql`), and a remote note stored after its replies
-- sets theirs here, as Mastodon's `ThreadResolveWorker` links a reply to a
-- parent that arrives late.

ALTER TABLE statuses ADD COLUMN in_reply_to_account_id TEXT;
ALTER TABLE statuses ADD COLUMN in_reply_to_actor_uri TEXT;
ALTER TABLE remote_statuses ADD COLUMN in_reply_to_account_id TEXT;
ALTER TABLE remote_statuses ADD COLUMN in_reply_to_actor_uri TEXT;

CREATE TRIGGER IF NOT EXISTS remote_statuses_link_replies AFTER INSERT ON remote_statuses
BEGIN
    UPDATE remote_statuses SET
        in_reply_to_account_id = CASE
            WHEN actor_uri = NEW.actor_uri AND NEW.in_reply_to_uri IS NOT NULL
            THEN NEW.in_reply_to_account_id
        END,
        in_reply_to_actor_uri = CASE
            WHEN actor_uri = NEW.actor_uri AND NEW.in_reply_to_uri IS NOT NULL
            THEN NEW.in_reply_to_actor_uri
            ELSE NEW.actor_uri
        END
    WHERE in_reply_to_uri = NEW.object_uri
      AND in_reply_to_account_id IS NULL
      AND in_reply_to_actor_uri IS NULL;
END;

-- The statuses stored before: each reply climbs its author's own statuses
-- (at most 1000 steps, as `server/own-ancestry.ts` did) to the first that
-- answers someone else, or to a root, which answers the author. A parent
-- that is not held leaves both NULL. A remote reply to a local status is
-- matched by the `/users/<username>/statuses/<id>` ending of its URI, as
-- migration 0138 counts replies: the instance's origin is configuration.

WITH RECURSIVE run (id, account_id, parent_id, parent_uri, depth) AS (
    SELECT id, account_id, in_reply_to_id, in_reply_to_uri, 0
    FROM statuses
    WHERE kind = 'LocalNote' AND (in_reply_to_id IS NOT NULL OR in_reply_to_uri IS NOT NULL)
    UNION ALL
    SELECT run.id, run.account_id, parent.in_reply_to_id, parent.in_reply_to_uri, run.depth + 1
    FROM run
    JOIN statuses AS parent ON parent.id = run.parent_id
    WHERE parent.account_id = run.account_id AND run.depth < 1000
),
top AS (
    SELECT id, account_id, parent_id, parent_uri, max(depth) AS depth FROM run GROUP BY id
)
UPDATE statuses SET
    in_reply_to_account_id = CASE
        WHEN top.parent_id IS NULL AND top.parent_uri IS NULL THEN top.account_id
        WHEN top.parent_id IS NOT NULL
        THEN (SELECT p.account_id FROM statuses p WHERE p.id = top.parent_id)
    END,
    in_reply_to_actor_uri = CASE
        WHEN top.parent_id IS NULL AND top.parent_uri IS NOT NULL
        THEN (SELECT p.actor_uri FROM remote_statuses p WHERE p.object_uri = top.parent_uri)
    END
FROM top
WHERE statuses.id = top.id;

WITH RECURSIVE run (id, actor_uri, parent_uri, depth) AS (
    SELECT id, actor_uri, in_reply_to_uri, 0
    FROM remote_statuses
    WHERE in_reply_to_uri IS NOT NULL
    UNION ALL
    SELECT run.id, run.actor_uri, parent.in_reply_to_uri, run.depth + 1
    FROM run
    JOIN remote_statuses AS parent ON parent.object_uri = run.parent_uri
    WHERE parent.actor_uri = run.actor_uri AND run.depth < 1000
),
top AS (
    SELECT id, actor_uri, parent_uri, max(depth) AS depth FROM run GROUP BY id
)
UPDATE remote_statuses SET
    in_reply_to_account_id = CASE
        WHEN top.parent_uri IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM remote_statuses p WHERE p.object_uri = top.parent_uri)
        THEN (
            SELECT l.account_id FROM statuses l JOIN accounts a ON a.id = l.account_id
            WHERE l.id = substr(top.parent_uri, -18)
              AND substr(top.parent_uri, -length('/users/' || a.username || '/statuses/' || l.id))
                  = '/users/' || a.username || '/statuses/' || l.id
        )
    END,
    in_reply_to_actor_uri = CASE
        WHEN top.parent_uri IS NULL THEN top.actor_uri
        ELSE (SELECT p.actor_uri FROM remote_statuses p WHERE p.object_uri = top.parent_uri)
    END
FROM top
WHERE remote_statuses.id = top.id;
