-- The poll a remote `Question` carries, as the JSON of the domain `RemotePoll`.
-- NULL for a plain note.
ALTER TABLE remote_statuses ADD COLUMN poll_json TEXT;
