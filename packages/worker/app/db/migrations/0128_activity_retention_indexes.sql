-- The `VacuumActivities` job (six-hourly cron) prunes `outbox_deliveries`,
-- `outbound_activities` and `inbox_activities` past their retention, oldest
-- first. These indexes keep each pass to the rows it may delete, so a pass
-- with nothing to prune reads next to nothing.

-- Finished delivery rows by last change. The `kind` list is the one in
-- `prisma/sql/pruneTerminalDeliveries.sql`; SQLite uses a partial index only
-- when the query repeats its WHERE term.
CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_finished
    ON outbox_deliveries (updated_at)
    WHERE kind IN ('Delivered', 'Failed', 'Expanded', 'Skipped');

CREATE INDEX IF NOT EXISTS idx_outbound_activities_created
    ON outbound_activities (created_at);

CREATE INDEX IF NOT EXISTS idx_inbox_activities_created
    ON inbox_activities (created_at);
