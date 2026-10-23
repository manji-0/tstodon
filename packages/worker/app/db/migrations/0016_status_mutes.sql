-- Conversation mutes: a status mute suppresses a whole reply thread.
-- Keyed by the thread root status id (as in cfwdon's thread mutes).

CREATE TABLE IF NOT EXISTS status_mutes (
    account_id TEXT NOT NULL,
    thread_root_status_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, thread_root_status_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
