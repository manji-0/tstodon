-- A `follow` or `follow_request` notification belongs to its follow, as in
-- Mastodon, where `Follow` and `FollowRequest` have `has_one :notification,
-- dependent: :destroy`: when the follow ends (unfollow, withdrawn or rejected
-- request, removed follower, block, Undo(Follow), account deletion) its
-- notification goes, and a held one leaves the notification requests with it.
-- An authorized request is destroyed too, and `AuthorizeFollowService` notifies
-- nothing in its place, so the `follow_request` notification goes when the row
-- leaves the pending state. A local sender is named by account id, a remote
-- one by actor URI.

-- The local triggers look a notification up by recipient and sender.
CREATE INDEX idx_notifications_account_from ON notifications (account_id, from_account_id);

CREATE TRIGGER follow_notifications_leave_with_follow
AFTER DELETE ON follows
BEGIN
  DELETE FROM notifications
  WHERE account_id = OLD.target_account_id
    AND from_account_id = OLD.follower_account_id
    AND kind IN ('follow', 'follow_request');
END;

CREATE TRIGGER follow_request_notification_leaves_when_authorized
AFTER UPDATE OF kind ON follows
WHEN OLD.kind = 'Pending' AND NEW.kind <> 'Pending'
BEGIN
  DELETE FROM notifications
  WHERE account_id = NEW.target_account_id
    AND from_account_id = NEW.follower_account_id
    AND kind = 'follow_request';
END;

CREATE TRIGGER remote_follow_notifications_leave_with_follow
AFTER DELETE ON remote_follows
BEGIN
  DELETE FROM notifications
  WHERE account_id = OLD.target_account_id
    AND from_actor_uri = OLD.remote_actor_uri
    AND kind IN ('follow', 'follow_request');
END;

CREATE TRIGGER remote_follow_request_notification_leaves_when_authorized
AFTER UPDATE OF remote_request_kind ON remote_follows
WHEN OLD.remote_request_kind = 'Queued' AND NEW.remote_request_kind <> 'Queued'
BEGIN
  DELETE FROM notifications
  WHERE account_id = NEW.target_account_id
    AND from_actor_uri = NEW.remote_actor_uri
    AND kind = 'follow_request';
END;
