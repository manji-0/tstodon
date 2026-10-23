-- Indexes for columns that hot queries and foreign-key cascades read without one.
-- Each was a full table scan under EXPLAIN QUERY PLAN.

-- Status rendering: boost counts and reblogged_by (`reblog_of_id = ?` / `IN`),
-- thread descendants (`in_reply_to_id IN`), and the SET NULL cascades a status
-- delete runs on both columns.
CREATE INDEX IF NOT EXISTS idx_statuses_reblog_of
    ON statuses (reblog_of_id, id) WHERE reblog_of_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_statuses_in_reply_to
    ON statuses (in_reply_to_id, id) WHERE in_reply_to_id IS NOT NULL;

-- Favourite counts and favourited_by, by status (the key leads with account_id).
CREATE INDEX IF NOT EXISTS idx_favourites_status
    ON favourites (status_id, id);

-- Cascades from a status delete.
CREATE INDEX IF NOT EXISTS idx_bookmarks_status ON bookmarks (status_id);
CREATE INDEX IF NOT EXISTS idx_status_pins_status ON status_pins (status_id);

-- Media of the statuses being loaded, and an account's media on delete.
CREATE INDEX IF NOT EXISTS idx_media_attachments_status
    ON media_attachments (status_id) WHERE status_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_attachments_account
    ON media_attachments (account_id);

-- The ActivityPub outbox and an account delete.
CREATE INDEX IF NOT EXISTS idx_outbound_activities_account
    ON outbound_activities (account_id, id);

-- The per-activity fan-out row (`inbox_url IS NULL`), read and updated on
-- every delivery; idx_outbox_deliveries_target only covers target rows.
CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_fanout
    ON outbox_deliveries (activity_id) WHERE inbox_url IS NULL;

-- Notifications from a remote actor, removed when it undoes or deletes.
CREATE INDEX IF NOT EXISTS idx_notifications_from_actor
    ON notifications (from_actor_uri) WHERE from_actor_uri IS NOT NULL;

-- Handle lookups compare case-insensitively.
CREATE INDEX IF NOT EXISTS idx_remote_actors_handle
    ON remote_actors (lower(domain), lower(username));

-- Per-account reads and account-delete cascades.
CREATE INDEX IF NOT EXISTS idx_filters_account ON filters (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_poll_votes_account ON poll_votes (account_id);
CREATE INDEX IF NOT EXISTS idx_reports_account ON reports (account_id);
CREATE INDEX IF NOT EXISTS idx_reports_target_account ON reports (target_account_id);
CREATE INDEX IF NOT EXISTS idx_suggestion_dismissals_target
    ON suggestion_dismissals (target_account_id);
