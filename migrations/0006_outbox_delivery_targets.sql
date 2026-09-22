ALTER TABLE outbox_deliveries ADD COLUMN inbox_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_deliveries_target
    ON outbox_deliveries (activity_id, inbox_url)
    WHERE inbox_url IS NOT NULL;
