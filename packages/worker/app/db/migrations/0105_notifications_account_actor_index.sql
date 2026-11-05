-- A user's domain block clears the blocker's notifications from the domain's
-- actors page by page (#67); this index serves the per-page listing and
-- delete by recipient and remote sender.
CREATE INDEX idx_notifications_account_actor ON notifications (account_id, from_actor_uri);
