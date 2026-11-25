-- The collections a report names (Mastodon 4.7 `collection_reports`): the
-- reported account's own, local or remote, rendered as `collection_ids` and
-- forwarded in its `Flag`.
CREATE TABLE report_collections (
  report_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  PRIMARY KEY (report_id, collection_id),
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);
