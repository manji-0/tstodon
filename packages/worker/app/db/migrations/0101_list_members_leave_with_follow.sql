-- A local account on a list belongs to the owner's follow of it, as in
-- Mastodon, where `list_accounts` cascades from `follows` and
-- `follow_requests`: when the follow (accepted or requested) is deleted by an
-- unfollow, a block, a rejected request or a removed follower, the account
-- leaves every list of the follower. The owner's own membership has no follow
-- and stays.
CREATE TRIGGER account_list_members_leave_with_follow
AFTER DELETE ON follows
BEGIN
  DELETE FROM account_list_members
  WHERE member_account_id = OLD.target_account_id
    AND list_id IN (SELECT id FROM account_lists WHERE account_id = OLD.follower_account_id);
END;
