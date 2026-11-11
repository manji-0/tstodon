-- The inbox claims an activity id before it applies the activity, and marks
-- the claim `Processed` only once the activity was applied or rejected. A
-- failed apply deletes its claim, so the sender's retry applies it again
-- instead of being answered as a duplicate. Rows written before this
-- migration were recorded as handled, so they start `Processed`.
--
-- `created_at` of a `Processing` row is when it was claimed: a claim older
-- than 15 minutes belongs to an apply that never finished (the Worker was cut
-- off), and the next delivery or the hourly cron takes it back.
ALTER TABLE inbox_activities ADD COLUMN state TEXT NOT NULL DEFAULT 'Processed'
    CHECK (state IN ('Processing', 'Processed'));

-- The open claims by age, for the hourly release of stale ones. SQLite uses a
-- partial index only when the query repeats its WHERE term.
CREATE INDEX IF NOT EXISTS idx_inbox_activities_processing
    ON inbox_activities (created_at)
    WHERE state = 'Processing';
