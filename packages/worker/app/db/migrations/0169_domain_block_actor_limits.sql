-- void:allow-destructive
-- (Only the view `remote_actor_domain_rules` is dropped and created again.)
--
-- Making an instance domain block silences or suspends every actor cached at
-- or under its domain then, a narrower rule notwithstanding, as Mastodon's
-- `BlockDomainService` sets `silenced_at` / `suspended_at` over
-- `Account.by_domain_and_subdomains`: an actor known before a narrower `noop`
-- stays limited there, while one first seen later follows its most specific
-- rule alone. A row names the block that limited the actor, which the
-- `RecordDomainBlockLimits` job writes in pages. The limitation is the
-- block's current severity, read through the join, so changing the block's
-- severity or removing it lifts what it set at once, as
-- `process_retroactive_updates!` and `UnblockDomainService` do; the job then
-- deletes the rows a `noop` or a removed block left. No foreign key: the rows
-- of a removed block go in pages, not in the request that removes it.

CREATE TABLE remote_actor_domain_limits (
    domain_block_id TEXT NOT NULL,
    actor_uri TEXT NOT NULL,
    PRIMARY KEY (domain_block_id, actor_uri)
);

CREATE INDEX idx_remote_actor_domain_limits_actor
    ON remote_actor_domain_limits (actor_uri, domain_block_id);

-- Migration 0163's view, with a third branch: the actors a block limited when
-- it was made, at its current severity. Those rows reject neither media nor
-- reports: Mastodon reads both from the rule each time.
DROP VIEW remote_actor_domain_rules;

CREATE VIEW remote_actor_domain_rules AS
SELECT r.actor_uri, d.severity, d.reject_media, d.reject_reports
FROM domain_blocks d
JOIN remote_actors r
  ON r.host_key >= d.domain_key
  AND r.host_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
WHERE NOT EXISTS (
  SELECT 1 FROM domain_blocks n
  WHERE n.domain_key > d.domain_key
    AND n.domain_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
    AND substr(r.host_key, 1, length(n.domain_key)) = n.domain_key
)
UNION ALL
SELECT r.actor_uri, d.severity, d.reject_media, d.reject_reports
FROM domain_blocks d
JOIN remote_actors r
  ON r.uri_host_key >= d.domain_key
  AND r.uri_host_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
WHERE NOT EXISTS (
  SELECT 1 FROM domain_blocks n
  WHERE n.domain_key > d.domain_key
    AND n.domain_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
    AND substr(r.uri_host_key, 1, length(n.domain_key)) = n.domain_key
)
UNION ALL
SELECT l.actor_uri, d.severity, 0, 0
FROM remote_actor_domain_limits l
JOIN domain_blocks d ON d.id = l.domain_block_id
WHERE d.severity IN ('silence', 'suspend');
