-- A domain block limits an actor by its account domain only, as Mastodon's
-- `Account.by_domain_and_subdomains` and `DomainBlock.rule_for(@domain)`.

-- The most specific instance domain block on each actor's account domain,
-- whatever its severity: the host key's parent domains, longest first, each
-- one seek of `idx_domain_blocks_domain_key`.
CREATE VIEW remote_actor_account_domain_rule AS
SELECT r.actor_uri, (
  WITH RECURSIVE prefixes(prefix, rest) AS (
    SELECT '', r.host_key
    UNION ALL
    SELECT prefix || substr(rest, 1, instr(rest, '.')), substr(rest, instr(rest, '.') + 1)
    FROM prefixes WHERE instr(rest, '.') > 0
  )
  SELECT d.id FROM prefixes p JOIN domain_blocks d ON d.domain_key = p.prefix
  WHERE p.prefix <> ''
  ORDER BY length(p.prefix) DESC
  LIMIT 1
) AS domain_block_id
FROM remote_actors r;

-- An actor first cached under a silence or suspension of its account domain
-- keeps it, a narrower rule made later notwithstanding, as
-- `ActivityPub::ProcessAccountService#create_account` sets `silenced_at` /
-- `suspended_at` from `DomainBlock.rule_for(@domain)`. Its host key is first
-- spelled by `remote_actors_insert_host_keys` right after the insert, so this
-- runs once per actor row; a re-fetch is an update and records nothing. A
-- fresh actor has no content to purge.
CREATE TRIGGER remote_actors_record_domain_limits AFTER UPDATE OF host_key ON remote_actors
WHEN OLD.host_key IS NULL AND NEW.host_key IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO remote_actor_domain_limits (domain_block_id, actor_uri)
  SELECT d.id, NEW.actor_uri FROM domain_blocks d
  WHERE d.id = (
    SELECT domain_block_id FROM remote_actor_account_domain_rule WHERE actor_uri = NEW.actor_uri
  ) AND d.severity IN ('silence', 'suspend');
END;

-- The actors cached before this trigger, after their rule's last change, so
-- that neither a recording (`Apply`) nor a backfill (`seen_by`) found them:
-- recorded under the rule that governs their account domain now, the closest
-- guess at the one that governed it when they were first seen. It may
-- over-record: an actor first seen under a narrower rule removed since is
-- recorded, where Mastodon left it unlimited.
INSERT OR IGNORE INTO remote_actor_domain_limits (domain_block_id, actor_uri)
SELECT d.id, r.actor_uri
FROM domain_blocks d
JOIN remote_actors r
  ON r.host_key >= d.domain_key
  AND r.host_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
WHERE d.severity IN ('silence', 'suspend')
  AND julianday(r.created_at) > julianday(d.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM domain_blocks n
    WHERE n.domain_key > d.domain_key
      AND n.domain_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
      AND substr(r.host_key, 1, length(n.domain_key)) = n.domain_key
  );

-- The rows a recording wrote for an actor by its URI's host alone, its
-- account domain outside the block, which Mastodon never limits; first the
-- content purges they queued, unless the actor's account domain is recorded
-- under a suspension too. A row whose actor's URI host is outside the block
-- as well was recorded by account domain before the domain changed
-- (`releaseRemoteActorHandle`, `settleHandleHolder`), and stays, as Mastodon
-- keeps `suspended_at` across a rename. A purge names no block, so two cases
-- are left as they are: the purge of an actor recorded by URI host alone
-- under a suspension removed since (its rows are gone) still runs, and the
-- purge of an actor recorded by both hosts under a suspension downgraded
-- since, and by URI host under another, is dropped.
DELETE FROM remote_actor_content_purges
WHERE actor_uri IN (
  SELECT l.actor_uri FROM remote_actor_domain_limits l
  JOIN domain_blocks d ON d.id = l.domain_block_id
  JOIN remote_actors r ON r.actor_uri = l.actor_uri
  WHERE NOT (
    r.host_key >= d.domain_key
    AND r.host_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
  )
    AND r.uri_host_key >= d.domain_key
    AND r.uri_host_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
)
AND actor_uri NOT IN (
  SELECT l.actor_uri FROM remote_actor_domain_limits l
  JOIN domain_blocks d ON d.id = l.domain_block_id
  JOIN remote_actors r ON r.actor_uri = l.actor_uri
  WHERE d.severity = 'suspend'
    AND r.host_key >= d.domain_key
    AND r.host_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
);

DELETE FROM remote_actor_domain_limits
WHERE rowid IN (
  SELECT l.rowid FROM remote_actor_domain_limits l
  JOIN domain_blocks d ON d.id = l.domain_block_id
  JOIN remote_actors r ON r.actor_uri = l.actor_uri
  WHERE NOT (
    r.host_key >= d.domain_key
    AND r.host_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
  )
    AND r.uri_host_key >= d.domain_key
    AND r.uri_host_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
);
