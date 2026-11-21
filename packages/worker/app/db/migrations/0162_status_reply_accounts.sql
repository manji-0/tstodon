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
            WHEN actor_uri = NEW.actor_uri THEN NEW.in_reply_to_account_id
        END,
        in_reply_to_actor_uri = CASE
            WHEN actor_uri = NEW.actor_uri
             AND (NEW.in_reply_to_uri IS NOT NULL OR NEW.in_reply_to_account_id IS NOT NULL
                  OR NEW.in_reply_to_actor_uri IS NOT NULL)
            THEN NEW.in_reply_to_actor_uri
            ELSE NEW.actor_uri
        END
    WHERE in_reply_to_uri = NEW.object_uri
      AND in_reply_to_account_id IS NULL
      AND in_reply_to_actor_uri IS NULL;
END;

-- The statuses stored before. Each thread is walked once, down from where an
-- author's run of their own statuses starts: a reply to someone else's
-- status answers that status's author, and a reply to the author's own root
-- answers the author. A reply to the author's own reply then takes that
-- reply's, one child at a time through the reply indexes, so each row is
-- read and written once (at most 1000 steps down, as `server/own-ancestry.ts`
-- climbed). A reply that answers no one is left NULL, and so are the replies
-- below it. A reply whose parent was deleted before this migration lost its
-- parent's author with `in_reply_to_id`, so it answers no one. A remote reply
-- to a local status is matched by the `/users/<username>/statuses/<id>`
-- ending of its URI, as migration 0138 counts replies: the instance's origin
-- is configuration.

WITH RECURSIVE answered (id, account_id, answer_account, answer_actor, depth) AS (
    SELECT s.id, s.account_id,
        CASE WHEN p.account_id = s.account_id THEN s.account_id ELSE p.account_id END,
        NULL, 0
    FROM statuses s
    JOIN statuses p ON p.id = s.in_reply_to_id
    WHERE s.kind = 'LocalNote'
      AND (p.account_id <> s.account_id OR (p.in_reply_to_id IS NULL AND p.in_reply_to_uri IS NULL))
    UNION ALL
    SELECT s.id, s.account_id, NULL, p.actor_uri, 0
    FROM statuses s
    JOIN remote_statuses p ON p.object_uri = s.in_reply_to_uri
    WHERE s.kind = 'LocalNote' AND s.in_reply_to_id IS NULL
    UNION ALL
    SELECT child.id, child.account_id, answered.answer_account, answered.answer_actor, answered.depth + 1
    FROM answered
    JOIN statuses child ON child.in_reply_to_id = answered.id
    WHERE child.kind = 'LocalNote' AND child.account_id = answered.account_id AND answered.depth < 1000
)
UPDATE statuses SET in_reply_to_account_id = answer_account, in_reply_to_actor_uri = answer_actor
FROM answered
WHERE statuses.id = answered.id;

WITH RECURSIVE answered (id, object_uri, actor_uri, answer_account, answer_actor, depth) AS (
    SELECT s.id, s.object_uri, s.actor_uri, NULL,
        CASE WHEN p.actor_uri = s.actor_uri THEN s.actor_uri ELSE p.actor_uri END,
        0
    FROM remote_statuses s
    JOIN remote_statuses p ON p.object_uri = s.in_reply_to_uri
    WHERE p.actor_uri <> s.actor_uri OR p.in_reply_to_uri IS NULL
    UNION ALL
    SELECT s.id, s.object_uri, s.actor_uri, l.account_id, NULL, 0
    FROM remote_statuses s
    JOIN statuses l ON l.id = substr(s.in_reply_to_uri, -18)
    JOIN accounts a ON a.id = l.account_id
    WHERE substr(s.in_reply_to_uri, -length('/users/' || a.username || '/statuses/' || l.id))
          = '/users/' || a.username || '/statuses/' || l.id
      AND NOT EXISTS (SELECT 1 FROM remote_statuses h WHERE h.object_uri = s.in_reply_to_uri)
    UNION ALL
    SELECT child.id, child.object_uri, child.actor_uri, answered.answer_account,
        answered.answer_actor, answered.depth + 1
    FROM answered
    JOIN remote_statuses child ON child.in_reply_to_uri = answered.object_uri
    WHERE child.actor_uri = answered.actor_uri AND answered.depth < 1000
)
UPDATE remote_statuses SET in_reply_to_account_id = answer_account, in_reply_to_actor_uri = answer_actor
FROM answered
WHERE remote_statuses.id = answered.id;
