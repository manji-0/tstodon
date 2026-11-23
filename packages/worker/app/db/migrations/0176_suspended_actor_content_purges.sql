-- The actors a domain suspension suspended whose content has yet to go, as
-- Mastodon's `BlockDomainService#suspend_accounts!` runs `DeleteAccountService`
-- with `reserve_username` on each: their statuses (with what cascades from
-- them, the local boosts of them included), their own boosts, favourites and
-- announces, and the notifications they sent. A `RecordDomainBlockLimits`
-- page of a suspension writes a row for each actor it records, and the
-- `PurgeSuspendedActorContent` pages delete what was stored by `before`, then
-- the row, whatever the block has become since: changing the suspension to a
-- silence or a `noop`, or removing it, brings none of it back, and what the
-- actor sends after the change stays.
CREATE TABLE remote_actor_content_purges (
    actor_uri TEXT PRIMARY KEY NOT NULL,
    before TEXT NOT NULL
);

-- The one chain of `PurgeSuspendedActorContent` pages that runs: each page
-- stamps `stamped_at`, the last one deletes the row, and a chain starts only
-- when the row is missing or no page stamped it for ten minutes.
CREATE TABLE remote_actor_content_purge_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    stamped_at TEXT NOT NULL
);

-- The suspensions recorded before this kept their actors' content: record
-- each again, in the backfill's pages (migration 0171), for the actors first
-- seen by its last change, which writes their rows here.
INSERT OR IGNORE INTO domain_block_limit_backfills (domain_block_id, seen_by)
SELECT id, updated_at FROM domain_blocks WHERE severity = 'suspend';
