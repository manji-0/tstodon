-- A note's `replies` pages list the cached replies to it in id order after
-- the last one served, so their index on the URI they answer carries the id:
-- a page seeks to `min_id` instead of sorting every reply to the note.

CREATE INDEX IF NOT EXISTS idx_remote_statuses_in_reply_to_uri_id
    ON remote_statuses (in_reply_to_uri, id);
DROP INDEX IF EXISTS idx_remote_statuses_in_reply_to_uri;
