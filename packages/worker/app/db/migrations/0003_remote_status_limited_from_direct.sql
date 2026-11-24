-- A cached remote note stored direct that a later `Create` at a personal
-- inbox made limited (`Create#postprocess_audience_and_deliver`). Mastodon
-- wrote its `AccountConversation` rows when it stored the note
-- (`FanOutOnWriteService#deliver_to_conversation!`) and the later
-- `update(visibility: :limited)` leaves them, so such a note stays in the
-- conversations and direct timeline of the accounts it mentions, and in the
-- direct reply chains conversations follow, as when it was direct.
ALTER TABLE remote_statuses ADD COLUMN limited_from_direct INTEGER NOT NULL DEFAULT 0;
