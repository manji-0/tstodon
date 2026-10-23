-- Thread context finds replies by the URI they answer: remote replies to
-- local or remote statuses, and local replies to remote ones.

CREATE INDEX idx_statuses_in_reply_to_uri ON statuses (in_reply_to_uri);
CREATE INDEX idx_remote_statuses_in_reply_to_uri ON remote_statuses (in_reply_to_uri);
