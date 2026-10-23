-- Trend review records: a moderator approves or rejects a trending tag, link,
-- or status; rejected targets stop appearing in the public trends lists while
-- unreviewed ones keep trending (review-on-rejection).

CREATE TABLE IF NOT EXISTS trend_reviews (
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    state TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    PRIMARY KEY (kind, target)
);

CREATE INDEX IF NOT EXISTS idx_trend_reviews_state ON trend_reviews (kind, state);
