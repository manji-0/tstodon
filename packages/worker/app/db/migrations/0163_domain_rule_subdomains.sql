-- An instance domain rule (silence, suspension, reject_media, reject_reports)
-- covers the domain it names and every subdomain of it, and a host follows
-- its most specific rule only, as Mastodon's `DomainBlock.rule_for`.
--
-- A host's key is its labels in reverse order, each followed by a dot:
-- `a.example.com` is `com.example.a.`. A rule on `example.com` (key
-- `com.example.`) covers exactly the hosts whose key starts with its key, so
-- the actors a rule covers are one index range, `[key, key with its last
-- '.' replaced by '/')`, and `x-example.com` (`com.x-example.`) stays out.

ALTER TABLE remote_actors ADD COLUMN host_key TEXT;
ALTER TABLE remote_actors ADD COLUMN uri_host_key TEXT;
ALTER TABLE domain_blocks ADD COLUMN domain_key TEXT;

-- Every key, spelled in one place for the triggers and the backfill alike.
-- A name is read as `Hostname.ofAuthority` reads it, so SQL and the Worker
-- agree on a row written by hand: lower case, port dropped (IPv6 brackets
-- kept), trailing dots dropped. SQLite has no string reversal, so a recursive
-- CTE moves one label per step.
CREATE VIEW host_keys AS
SELECT source, id, (
  WITH RECURSIVE k(rest, key) AS (
    SELECT rtrim(
      CASE
        WHEN substr(name, 1, 1) = '[' THEN substr(name, 1, instr(name, ']'))
        WHEN instr(name, ':') > 0 THEN substr(name, 1, instr(name, ':') - 1)
        ELSE name
      END,
      '.'
    ) || '.', ''
    UNION ALL
    SELECT substr(rest, instr(rest, '.') + 1), substr(rest, 1, instr(rest, '.')) || key
    FROM k WHERE rest <> ''
  )
  SELECT key FROM k WHERE rest = ''
) AS key
FROM (
  SELECT 'host' AS source, actor_uri AS id, lower(host) AS name FROM remote_actors
  UNION ALL
  SELECT 'uri_host', actor_uri, lower(uri_host) FROM remote_actors
  UNION ALL
  SELECT 'domain', id, lower(domain) FROM domain_blocks
);

-- Each row is written once: its keys in the same UPDATE.
UPDATE remote_actors SET
  host_key = (SELECT key FROM host_keys WHERE source = 'host' AND id = remote_actors.actor_uri),
  uri_host_key = (SELECT key FROM host_keys WHERE source = 'uri_host' AND id = remote_actors.actor_uri);
UPDATE domain_blocks SET
  domain_key = (SELECT key FROM host_keys WHERE source = 'domain' AND id = domain_blocks.id);

CREATE TRIGGER remote_actors_insert_host_keys AFTER INSERT ON remote_actors
BEGIN
  UPDATE remote_actors SET
    host_key = (SELECT key FROM host_keys WHERE source = 'host' AND id = NEW.actor_uri),
    uri_host_key = (SELECT key FROM host_keys WHERE source = 'uri_host' AND id = NEW.actor_uri)
  WHERE actor_uri = NEW.actor_uri;
END;

-- The upserts rewrite `domain` on every refresh; only a changed one is
-- spelled again.
CREATE TRIGGER remote_actors_update_host_keys AFTER UPDATE OF domain, actor_uri ON remote_actors
WHEN OLD.domain IS NOT NEW.domain OR OLD.actor_uri IS NOT NEW.actor_uri
BEGIN
  UPDATE remote_actors SET
    host_key = (SELECT key FROM host_keys WHERE source = 'host' AND id = NEW.actor_uri),
    uri_host_key = (SELECT key FROM host_keys WHERE source = 'uri_host' AND id = NEW.actor_uri)
  WHERE actor_uri = NEW.actor_uri;
END;

CREATE TRIGGER domain_blocks_insert_domain_key AFTER INSERT ON domain_blocks
BEGIN
  UPDATE domain_blocks SET
    domain_key = (SELECT key FROM host_keys WHERE source = 'domain' AND id = NEW.id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER domain_blocks_update_domain_key AFTER UPDATE OF domain ON domain_blocks
WHEN OLD.domain IS NOT NEW.domain
BEGIN
  UPDATE domain_blocks SET
    domain_key = (SELECT key FROM host_keys WHERE source = 'domain' AND id = NEW.id)
  WHERE id = NEW.id;
END;

CREATE INDEX idx_remote_actors_host_key ON remote_actors (host_key);
CREATE INDEX idx_remote_actors_uri_host_key ON remote_actors (uri_host_key);
CREATE INDEX idx_domain_blocks_domain_key ON domain_blocks (domain_key);

-- The rule each remote actor follows on each of its hosts, the account
-- domain's (`host`) and the actor URI's (`uri_host`), as
-- `RemoteActor.onAnyHost`: an actor has a row per host some rule covers, with
-- that host's most specific rule. A query names the severity or flag it
-- needs, and SQLite walks the rules with it and each one's key range of
-- actors, so it reads the actors the rules cover, never every actor.
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
);
