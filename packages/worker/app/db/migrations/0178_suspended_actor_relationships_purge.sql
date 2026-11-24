-- A domain suspension's purge now also deletes the blocks, mutes and
-- endorsements local accounts hold of each actor it records, and the actor's
-- blocks of them, its featured hashtags and its cached profile, as Mastodon's
-- `DeleteAccountService` with `reserve_username` does. The purges run before
-- left those: record each suspension again, in the backfill's pages (migration
-- 0171), for the actors first seen by its last change, which queues their
-- purge again (`remote_actor_content_purges`) with the time of that recording
-- as its cut-off (`before`). So it also deletes what local accounts made of a
-- still-suspended actor since the suspension (a block, a mute, an
-- endorsement), as Mastodon's `DomainBlockWorker` run again for the block
-- would: `DeleteAccountService` runs again on each account whose
-- `suspended_at` is the block's `created_at`.
INSERT OR IGNORE INTO domain_block_limit_backfills (domain_block_id, seen_by)
SELECT id, updated_at FROM domain_blocks WHERE severity = 'suspend';
