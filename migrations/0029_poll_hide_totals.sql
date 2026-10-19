-- Polls may hide their results until they end (`poll[hide_totals]`).

ALTER TABLE polls ADD COLUMN hide_totals INTEGER NOT NULL DEFAULT 0;
