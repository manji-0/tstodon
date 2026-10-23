-- v2 filters can be narrowed to specific statuses.

CREATE TABLE IF NOT EXISTS filter_statuses (
    filter_id TEXT NOT NULL,
    status_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (filter_id, status_id),
    FOREIGN KEY (filter_id) REFERENCES filters(id) ON DELETE CASCADE
);
