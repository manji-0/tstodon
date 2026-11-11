-- Indexes for id-cursor pages that sorted every match under EXPLAIN QUERY PLAN.

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
