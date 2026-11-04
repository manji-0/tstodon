-- The hostname of `remote_actors.domain` without its port: what domain blocks,
-- suspensions and the allow list name, so a block on `peer.test` covers
-- `peer.test:8792` too. Derived, so it cannot drift from `domain`.
ALTER TABLE remote_actors ADD COLUMN host TEXT GENERATED ALWAYS AS (
  lower(
    CASE
      WHEN substr(domain, 1, 1) = '[' THEN substr(domain, 1, instr(domain, ']'))
      WHEN instr(domain, ':') > 0 THEN substr(domain, 1, instr(domain, ':') - 1)
      ELSE domain
    END
  )
) VIRTUAL;

CREATE INDEX idx_remote_actors_host ON remote_actors (host);
