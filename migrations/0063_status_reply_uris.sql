-- A local note can reply to a cached remote status. `in_reply_to_id` keeps
-- its foreign key to local statuses, so a remote parent is recorded by its
-- object URI instead, and rendered by looking the URI up in `remote_statuses`.

ALTER TABLE statuses ADD COLUMN in_reply_to_uri TEXT;
