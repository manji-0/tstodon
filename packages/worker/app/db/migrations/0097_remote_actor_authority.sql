-- `remote_actors.domain` is the actor's authority, `host[:port]`, as Mastodon
-- stores it, so `@bob@peer.test:8792` and `@bob@peer.test` are two accounts
-- and render with their port. Rows cached before this kept only the hostname;
-- recompute them from `actor_uri`. A URL's authority runs from after `://` to
-- the first `/`, `?` or `#`; the port stays and the case is folded.
UPDATE remote_actors
SET domain = lower(
  substr(
    substr(actor_uri, instr(actor_uri, '://') + 3),
    1,
    min(
      instr(substr(actor_uri, instr(actor_uri, '://') + 3) || '/', '/'),
      instr(substr(actor_uri, instr(actor_uri, '://') + 3) || '?', '?'),
      instr(substr(actor_uri, instr(actor_uri, '://') + 3) || '#', '#')
    ) - 1
  )
)
WHERE instr(actor_uri, '://') > 0;

-- Moderation names hostnames: a block on `peer.test` covers every port of it
-- and a block typed with a port is kept as its hostname. A row that would
-- duplicate a block on the bare hostname is dropped.
UPDATE OR IGNORE domain_blocks
SET domain = substr(domain, 1, instr(domain, ':') - 1)
WHERE instr(domain, ':') > 0;
DELETE FROM domain_blocks WHERE instr(domain, ':') > 0;

UPDATE OR IGNORE account_domain_blocks
SET domain = substr(domain, 1, instr(domain, ':') - 1)
WHERE instr(domain, ':') > 0;
DELETE FROM account_domain_blocks WHERE instr(domain, ':') > 0;
