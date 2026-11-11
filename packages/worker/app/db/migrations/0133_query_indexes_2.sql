-- Indexes for queries and foreign-key cascades that read a table without one.
-- Each was a full scan (or a sort of every match) under EXPLAIN QUERY PLAN.

-- The hourly tag backfill (`listUnindexedRemoteStatuses`) walked every remote
-- status to find the few with `tags_indexed = 0`.
CREATE INDEX IF NOT EXISTS idx_remote_statuses_tags_pending
    ON remote_statuses (id) WHERE tags_indexed = 0;

-- Cascades: a remote status delete into its pins, an account delete into its
-- remote poll votes and severed relationships.
CREATE INDEX IF NOT EXISTS idx_remote_actor_pins_status ON remote_actor_pins (status_id);
CREATE INDEX IF NOT EXISTS idx_remote_poll_own_votes_account
    ON remote_poll_own_votes (account_id);
CREATE INDEX IF NOT EXISTS idx_severed_relationships_local_account
    ON severed_relationships (local_account_id);

-- The link card refresh (`listStaleLinkCards`), oldest first.
CREATE INDEX IF NOT EXISTS idx_link_cards_fetched ON link_cards (fetched_at);

-- `cancelRemoteActorDeliveries`: the queued deliveries to a gone actor's
-- inboxes, kept when another actor still shares the inbox.
CREATE INDEX IF NOT EXISTS idx_remote_actors_inbox ON remote_actors (inbox_uri);
CREATE INDEX IF NOT EXISTS idx_remote_actors_shared_inbox ON remote_actors (shared_inbox_uri);
CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_queued_inbox
    ON outbox_deliveries (inbox_url) WHERE kind = 'Queued';

-- The `purgeRemoteActor*` deletes run when a remote actor is removed.
CREATE INDEX IF NOT EXISTS idx_endorsements_target_actor_uri ON endorsements (target_actor_uri);
CREATE INDEX IF NOT EXISTS idx_notification_request_groups_from_account_id
    ON notification_request_groups (from_account_id);
CREATE INDEX IF NOT EXISTS idx_notification_request_acceptances_from_account_id
    ON notification_request_acceptances (from_account_id);
CREATE INDEX IF NOT EXISTS idx_conversation_hides_conversation_id
    ON conversation_hides (conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_reads_conversation_id
    ON conversation_reads (conversation_id);
CREATE INDEX IF NOT EXISTS idx_status_mutes_thread_root_status_id
    ON status_mutes (thread_root_status_id);
CREATE INDEX IF NOT EXISTS idx_notification_dismissals_notification_id
    ON notification_dismissals (notification_id);

-- Following counts (`accountCounts`, `countFollowingByAccountIdsJson`) and the
-- followed-account lists: a covering search instead of a row read per follow.
CREATE INDEX IF NOT EXISTS idx_follows_follower_kind ON follows (follower_account_id, kind);
CREATE INDEX IF NOT EXISTS idx_outbound_follows_account_state
    ON outbound_follows (account_id, state);

-- Id-cursor pages (`<filter> AND id < ? ORDER BY id DESC LIMIT ?`) of the
-- public, direct, profile and remote actor timelines, without sorting every
-- match; also the statuses count of `accountCounts`.
CREATE INDEX IF NOT EXISTS idx_remote_statuses_visibility_id ON remote_statuses (visibility, id);
CREATE INDEX IF NOT EXISTS idx_remote_statuses_actor_id ON remote_statuses (actor_uri, id);
CREATE INDEX IF NOT EXISTS idx_statuses_visibility_id ON statuses (visibility, id);
CREATE INDEX IF NOT EXISTS idx_statuses_account_id ON statuses (account_id, id);

-- The link timelines (`card_url = ? AND visibility = 'public'`, id cursor).
-- Without these, the planner (with no table statistics) prefers the
-- visibility indexes above to the card_url ones and walks every public status.
CREATE INDEX IF NOT EXISTS idx_remote_statuses_card_url_visibility
    ON remote_statuses (card_url, visibility, id) WHERE card_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_statuses_card_url_visibility
    ON statuses (card_url, visibility, id) WHERE card_url IS NOT NULL;

-- An account's boost of one status (`account_id = ? AND reblog_of_id = ?`, and
-- the remote twin), without reading every boost of a popular status.
CREATE INDEX IF NOT EXISTS idx_statuses_account_reblog
    ON statuses (account_id, reblog_of_id) WHERE reblog_of_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_statuses_account_reblog_remote
    ON statuses (account_id, reblog_of_remote_id) WHERE reblog_of_remote_id IS NOT NULL;
