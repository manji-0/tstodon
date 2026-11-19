-- The URIs of remote statuses their authors deleted, as Mastodon's
-- `Tombstone`: a `Create` of one, replayed with its Linked Data signature
-- or delivered late, is not stored again (`tombstone_exists?`). Kept, as
-- Mastodon keeps them.
CREATE TABLE remote_status_tombstones (
  object_uri TEXT PRIMARY KEY,
  actor_uri TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The id of the inbound activity an outbound one forwards: one forward per
-- inbound activity, however often its handling is retried.
ALTER TABLE outbound_activities ADD COLUMN forward_of TEXT;

CREATE UNIQUE INDEX idx_outbound_activities_forward_of
  ON outbound_activities (forward_of) WHERE forward_of IS NOT NULL;
