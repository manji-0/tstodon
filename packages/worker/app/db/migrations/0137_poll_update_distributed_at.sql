-- When the last `DistributePollUpdate` job of the poll started. A remote vote
-- that is delivered again is distributed only when it was counted after that:
-- the same vote under new activity ids cannot make the poll federate again.
ALTER TABLE polls ADD COLUMN update_distributed_at TEXT;
