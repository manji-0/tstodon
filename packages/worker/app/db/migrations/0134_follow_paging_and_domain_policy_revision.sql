-- Indexes for id-cursor pages that sorted every match under EXPLAIN QUERY PLAN,
-- and a revision token that spares reading the domain policy lists per request.

-- `listFollowers` (remote branch) and `listFollowing` (both branches): each
-- branch searches `<owner> = ? AND id <cursor>` in id order, so the page
-- merges the two branches instead of sorting every follow. The local branch
-- of `listFollowers` already has `idx_follows_target_id`.
CREATE INDEX IF NOT EXISTS idx_remote_follows_target_id ON remote_follows (target_account_id, id);
CREATE INDEX IF NOT EXISTS idx_follows_follower_id ON follows (follower_account_id, id);
CREATE INDEX IF NOT EXISTS idx_outbound_follows_account_id ON outbound_follows (account_id, id);

-- `listDirectStatusesForAccount`: the viewer's own direct notes in id order,
-- without walking every status they wrote or every direct note on the instance.
CREATE INDEX IF NOT EXISTS idx_statuses_direct_account_id
    ON statuses (account_id, id) WHERE visibility = 'direct';

-- The domain policy revision: a token every write to `domain_blocks` or
-- `domain_allows` replaces with a fresh random one, in the same statement.
-- `readDomainPolicy` (server/domain-policy-revision.ts) keeps an isolate copy
-- of the suspended, media-rejected, and allowed domains with the token it
-- was read at, and reads only this row while the token still matches. A
-- migration that rebuilds either table must recreate its triggers.
CREATE TABLE IF NOT EXISTS domain_policy_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL
);
INSERT OR IGNORE INTO domain_policy_revision (id, token) VALUES (1, lower(hex(randomblob(16))));

CREATE TRIGGER IF NOT EXISTS domain_blocks_insert_revision AFTER INSERT ON domain_blocks
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS domain_blocks_update_revision AFTER UPDATE ON domain_blocks
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS domain_blocks_delete_revision AFTER DELETE ON domain_blocks
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS domain_allows_insert_revision AFTER INSERT ON domain_allows
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS domain_allows_update_revision AFTER UPDATE ON domain_allows
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS domain_allows_delete_revision AFTER DELETE ON domain_allows
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;
