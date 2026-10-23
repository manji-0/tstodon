-- Web Push subscriptions (`/api/v1/push/subscription`). Mastodon keys one per
-- access token; tstodon tokens carry no token identity, so a subscription is
-- one per (account, push endpoint) — each browser or device has its own
-- endpoint — and the API addresses the account's most recently updated one.

CREATE TABLE push_subscriptions (
  -- Mastodon reports the subscription id as a JSON number, so it stays a small integer.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  standard INTEGER NOT NULL DEFAULT 0,
  alerts_json TEXT NOT NULL DEFAULT '{}',
  policy TEXT NOT NULL DEFAULT 'all',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, endpoint),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_push_subscriptions_account_updated
  ON push_subscriptions (account_id, updated_at DESC, id DESC);
