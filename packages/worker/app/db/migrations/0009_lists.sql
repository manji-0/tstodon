CREATE TABLE IF NOT EXISTS account_lists (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    title TEXT NOT NULL,
    replies_policy TEXT NOT NULL DEFAULT 'list'
        CHECK (replies_policy IN ('followed', 'list', 'none')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_lists_owner
    ON account_lists (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS account_list_members (
    list_id TEXT NOT NULL,
    member_account_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (list_id, member_account_id),
    FOREIGN KEY (list_id) REFERENCES account_lists(id) ON DELETE CASCADE,
    FOREIGN KEY (member_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_list_members_member
    ON account_list_members (member_account_id, list_id);
