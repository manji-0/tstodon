-- The hostname of an actor URI, read as `Hostname.ofAuthority` reads the text
-- between `://` and the first `/`: lower case, port and trailing dots dropped,
-- IPv6 brackets kept. An instance rule (silence, suspension, reject_media,
-- reject_reports, the allow list) and a user's domain block apply when they
-- name this host or `host`, the account domain's, so an account domain
-- elsewhere never lifts a rule on the host that serves the actor. Actor fetch
-- refuses a URI whose authority is not ASCII or whose parsed host and port
-- read otherwise (SQLite's `lower` folds ASCII only). Derived, so it cannot
-- drift from `actor_uri`.
ALTER TABLE remote_actors ADD COLUMN uri_authority TEXT GENERATED ALWAYS AS (
  CASE
    WHEN instr(substr(actor_uri, instr(actor_uri, '://') + 3), '/') > 0
      THEN substr(
        substr(actor_uri, instr(actor_uri, '://') + 3),
        1,
        instr(substr(actor_uri, instr(actor_uri, '://') + 3), '/') - 1
      )
    ELSE substr(actor_uri, instr(actor_uri, '://') + 3)
  END
) VIRTUAL;

ALTER TABLE remote_actors ADD COLUMN uri_host TEXT GENERATED ALWAYS AS (
  rtrim(
    lower(
      CASE
        WHEN substr(uri_authority, 1, 1) = '[' THEN substr(uri_authority, 1, instr(uri_authority, ']'))
        WHEN instr(uri_authority, ':') > 0 THEN substr(uri_authority, 1, instr(uri_authority, ':') - 1)
        ELSE uri_authority
      END
    ),
    '.'
  )
) VIRTUAL;

CREATE INDEX idx_remote_actors_uri_host ON remote_actors (uri_host);

-- When WebFinger last confirmed the row's handle (Mastodon's
-- `last_webfingered_at`); NULL while the handle is the URI's authority. A
-- failed or skipped round trip (an outage, an actor's own `Update`) keeps it,
-- so a handle lookup prefers the row confirmed last.
ALTER TABLE remote_actors ADD COLUMN last_webfingered_at TEXT;

-- When the stale-actor refresh last tried this row. A row is due once both
-- this and its last confirmation (its fetch, for a row WebFinger never
-- confirmed) are a day old, oldest first, so an actor whose server never
-- answers moves to the back instead of holding the head of the queue, and an
-- actor's own `Update`s, which skip WebFinger, never keep its handle from
-- being confirmed again.
ALTER TABLE remote_actors ADD COLUMN refresh_attempted_at TEXT;

CREATE INDEX idx_remote_actors_refresh_due
  ON remote_actors (max(coalesce(last_webfingered_at, fetched_at), coalesce(refresh_attempted_at, '')));
