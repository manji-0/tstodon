-- Partial indexes on the quoting columns. A quote is made by a local status
-- (`status_id`) or by a remote one (`remote_status_id`), so each unique
-- column is mostly NULL, and once `ANALYZE` (or `PRAGMA optimize`) has run,
-- the statistics of its unique index count the NULLs as one value and call
-- the index unselective: the lookup every rendered page makes,
-- `findQuotesByQuoting`, scanned `status_quotes` (2,000 rows per lookup on
-- the benchmark's 1,990 quotes, `pnpm bench --analyze`). These indexes hold
-- only the non-NULL rows, so their statistics stay selective.
CREATE INDEX idx_status_quotes_status ON status_quotes (status_id)
  WHERE status_id IS NOT NULL;

CREATE INDEX idx_status_quotes_remote_status ON status_quotes (remote_status_id)
  WHERE remote_status_id IS NOT NULL;
