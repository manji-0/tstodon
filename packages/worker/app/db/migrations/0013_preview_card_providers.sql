-- Mastodon's `preview_card_providers`: a link publisher, named by its host.
-- The six-hourly cron writes one for each host whose links trend and has no
-- row yet, with `requested_review_at` (`Trends::Links#request_review`), and
-- `/api/v1/admin/trends/links/publishers` pages the rows by `id`, newest
-- first. Approve and reject set `trendable` and `reviewed_at`; a host whose
-- row is `trendable = 0` has its links left out of the link trends and the
-- link timeline. `id` counts up as Mastodon's `bigserial` does.
CREATE TABLE preview_card_providers (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  trendable INTEGER,
  reviewed_at TEXT,
  requested_review_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The publisher reviews `trend_reviews` held become provider rows.
INSERT INTO preview_card_providers (domain, trendable, reviewed_at, created_at, updated_at)
SELECT target, state = 'Approved', reviewed_at, reviewed_at, reviewed_at
FROM trend_reviews
WHERE kind = 'Publisher'
ORDER BY reviewed_at, target;

DELETE FROM trend_reviews WHERE kind = 'Publisher';
