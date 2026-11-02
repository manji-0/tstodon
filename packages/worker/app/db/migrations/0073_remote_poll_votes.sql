-- Votes that remote accounts cast on a local poll: one row per chosen option.
-- `object_uri` is the vote's `Note` URI, kept to tell a redelivery from a new vote.
CREATE TABLE IF NOT EXISTS remote_poll_votes (
    poll_id TEXT NOT NULL,
    actor_uri TEXT NOT NULL,
    option_index INTEGER NOT NULL,
    object_uri TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (poll_id, actor_uri, option_index),
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
);
