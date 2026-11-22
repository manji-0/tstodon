-- void:allow-destructive
-- (Only the view `remote_actor_domain_rules` is dropped and created again.)
--
-- An admin's per-account unsilence or unsuspend of a remote actor lifts the
-- silence or suspension an instance domain block holds on it, as Mastodon's
-- `Account#unsilence!` / `#unsuspend!` clear the `silenced_at` /
-- `suspended_at` that `BlockDomainService` set. A lift names the block and the
-- severity it lifted; it holds only while the block keeps that severity, and
-- applying the block again (`DomainBlockWorker` after an edit) deletes it, as
-- `process_domain_block!` limits the account again.

CREATE TABLE remote_actor_domain_lifts (
    domain_block_id TEXT NOT NULL,
    actor_uri TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('silence', 'suspend')),
    PRIMARY KEY (domain_block_id, actor_uri)
);

CREATE INDEX idx_remote_actor_domain_lifts_actor
    ON remote_actor_domain_lifts (actor_uri);

-- The silences and suspensions made before migration 0169 recorded no actors.
-- Each is recorded once, in queued pages, for the actors first seen by its
-- last change (`seen_by`), when Mastodon's `BlockDomainService` last ran over
-- `Account.by_domain_and_subdomains`; the hourly sweep starts it.
CREATE TABLE domain_block_limit_backfills (
    domain_block_id TEXT PRIMARY KEY NOT NULL,
    seen_by TEXT NOT NULL
);

INSERT INTO domain_block_limit_backfills (domain_block_id, seen_by)
SELECT id, updated_at FROM domain_blocks WHERE severity IN ('silence', 'suspend');

-- Migration 0169's view with the block each row comes from, and without the
-- rows an admin lifted. No reader takes a lifted actor's media or report rule
-- from the view, and a column that is not the block's own severity would keep
-- a reader's `severity = ?` from seeking the blocks by their index.
DROP VIEW remote_actor_domain_rules;

CREATE VIEW remote_actor_domain_rules AS
SELECT r.actor_uri, d.id AS domain_block_id,
  d.severity, d.reject_media, d.reject_reports
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
AND NOT EXISTS (
  SELECT 1 FROM remote_actor_domain_lifts x
  WHERE x.domain_block_id = d.id AND x.actor_uri = r.actor_uri AND x.severity = d.severity
)
UNION ALL
SELECT r.actor_uri, d.id AS domain_block_id,
  d.severity, d.reject_media, d.reject_reports
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
AND NOT EXISTS (
  SELECT 1 FROM remote_actor_domain_lifts x
  WHERE x.domain_block_id = d.id AND x.actor_uri = r.actor_uri AND x.severity = d.severity
)
UNION ALL
SELECT l.actor_uri, d.id AS domain_block_id, d.severity, 0, 0
FROM remote_actor_domain_limits l
JOIN domain_blocks d ON d.id = l.domain_block_id
WHERE d.severity IN ('silence', 'suspend')
  AND NOT EXISTS (
    SELECT 1 FROM remote_actor_domain_lifts x
    WHERE x.domain_block_id = l.domain_block_id AND x.actor_uri = l.actor_uri AND x.severity = d.severity
  );
