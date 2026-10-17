-- Announcement viewer state: dismissals and reactions.
-- Announcement bodies themselves come from the ANNOUNCEMENTS var.

CREATE TABLE IF NOT EXISTS account_announcement_dismissals (
    account_id TEXT NOT NULL,
    announcement_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, announcement_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_announcement_reactions (
    account_id TEXT NOT NULL,
    announcement_id TEXT NOT NULL,
    reaction_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, announcement_id, reaction_name),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_announcement_reactions_group
    ON account_announcement_reactions (announcement_id, reaction_name);
