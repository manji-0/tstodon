-- An instance domain rule (silence, suspension, reject_media, reject_reports)
-- covers the domain it names and every subdomain of it, and a host follows
-- its most specific rule only, as Mastodon's `DomainBlock.rule_for`.
--
-- A host's key is the host spelled backwards with a trailing dot:
-- `a.example.com` is `moc.elpmaxe.a.`. A rule on `example.com` (key
-- `moc.elpmaxe.`) covers exactly the hosts whose key starts with its key, so
-- the actors a rule covers are one index range, `[key, key with its last
-- '.' replaced by '/')`, and `x-example.com` (`moc.elpmaxe-x.`) stays out.
-- SQLite has no string reversal, so triggers spell each key with a recursive
-- CTE whenever a row is written; no writer has to.

ALTER TABLE remote_actors ADD COLUMN host_key TEXT;
ALTER TABLE remote_actors ADD COLUMN uri_host_key TEXT;
ALTER TABLE domain_blocks ADD COLUMN domain_key TEXT;

CREATE TRIGGER remote_actors_insert_host_keys AFTER INSERT ON remote_actors
BEGIN
  UPDATE remote_actors SET
    host_key = (
      WITH RECURSIVE k(rest, key) AS (
        SELECT NEW.host, '.' UNION ALL SELECT substr(rest, 2), substr(rest, 1, 1) || key FROM k WHERE rest <> ''
      ) SELECT key FROM k WHERE rest = ''),
    uri_host_key = (
      WITH RECURSIVE k(rest, key) AS (
        SELECT NEW.uri_host, '.' UNION ALL SELECT substr(rest, 2), substr(rest, 1, 1) || key FROM k WHERE rest <> ''
      ) SELECT key FROM k WHERE rest = '')
  WHERE actor_uri = NEW.actor_uri;
END;

-- The upserts rewrite `domain` on every refresh; only a changed one, or a row
-- without keys yet, is spelled again.
CREATE TRIGGER remote_actors_update_host_keys AFTER UPDATE OF domain, actor_uri ON remote_actors
WHEN OLD.domain IS NOT NEW.domain OR OLD.actor_uri IS NOT NEW.actor_uri OR NEW.host_key IS NULL
BEGIN
  UPDATE remote_actors SET
    host_key = (
      WITH RECURSIVE k(rest, key) AS (
        SELECT NEW.host, '.' UNION ALL SELECT substr(rest, 2), substr(rest, 1, 1) || key FROM k WHERE rest <> ''
      ) SELECT key FROM k WHERE rest = ''),
    uri_host_key = (
      WITH RECURSIVE k(rest, key) AS (
        SELECT NEW.uri_host, '.' UNION ALL SELECT substr(rest, 2), substr(rest, 1, 1) || key FROM k WHERE rest <> ''
      ) SELECT key FROM k WHERE rest = '')
  WHERE actor_uri = NEW.actor_uri;
END;

CREATE TRIGGER domain_blocks_insert_domain_key AFTER INSERT ON domain_blocks
BEGIN
  UPDATE domain_blocks SET domain_key = (
    WITH RECURSIVE k(rest, key) AS (
      SELECT lower(NEW.domain), '.' UNION ALL SELECT substr(rest, 2), substr(rest, 1, 1) || key FROM k WHERE rest <> ''
    ) SELECT key FROM k WHERE rest = '')
  WHERE id = NEW.id;
END;

CREATE TRIGGER domain_blocks_update_domain_key AFTER UPDATE OF domain ON domain_blocks
WHEN OLD.domain IS NOT NEW.domain OR NEW.domain_key IS NULL
BEGIN
  UPDATE domain_blocks SET domain_key = (
    WITH RECURSIVE k(rest, key) AS (
      SELECT lower(NEW.domain), '.' UNION ALL SELECT substr(rest, 2), substr(rest, 1, 1) || key FROM k WHERE rest <> ''
    ) SELECT key FROM k WHERE rest = '')
  WHERE id = NEW.id;
END;

-- Spell the keys of the rows already stored, through the update triggers.
UPDATE remote_actors SET domain = domain;
UPDATE domain_blocks SET domain = domain;

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
