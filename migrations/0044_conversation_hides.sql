-- "Remove a conversation": the thread stays out of the viewer's list until a
-- newer status arrives in it.

CREATE TABLE IF NOT EXISTS conversation_hides (
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    hidden_status_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    PRIMARY KEY (account_id, conversation_id)
);
