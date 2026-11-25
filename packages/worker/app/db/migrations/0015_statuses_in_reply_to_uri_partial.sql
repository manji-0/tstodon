-- Index only the local statuses that answer a remote status by URI. Most
-- local statuses have no `in_reply_to_uri`, so once `ANALYZE` (or
-- `PRAGMA optimize`) has run, the full index's statistics call it
-- unselective, and the reply count that `remote_statuses_insert_replies_count`
-- keeps for every stored remote status scanned the public and unlisted local
-- statuses instead: 180,034 rows read per inbox `Create` on the benchmark's
-- 200,000 local statuses (`pnpm bench --analyze`, 0 after). Every lookup by
-- `in_reply_to_uri = ?` can use the partial index.
-- void:allow-destructive
-- The index is replaced by a partial one on the same column; no row is dropped.
DROP INDEX idx_statuses_in_reply_to_uri;

CREATE INDEX idx_statuses_in_reply_to_uri ON statuses (in_reply_to_uri)
  WHERE in_reply_to_uri IS NOT NULL;
