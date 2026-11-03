-- Set while a `DistributePollUpdate` job is queued for the poll, so a burst
-- of votes federates one `Update(Question)` instead of one per vote.
ALTER TABLE polls ADD COLUMN update_queued_at TEXT;
