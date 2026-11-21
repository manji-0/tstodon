-- A domain block names a lower-case hostname (`Hostname`), and queries seek
-- `domain_blocks.domain` by key against lower-case hosts. Fold any row stored
-- in another case. A row that would duplicate a block on the lower-case
-- domain is dropped, and the existing block on that domain is kept.
UPDATE OR IGNORE domain_blocks SET domain = lower(domain) WHERE domain <> lower(domain);
DELETE FROM domain_blocks WHERE domain <> lower(domain);
