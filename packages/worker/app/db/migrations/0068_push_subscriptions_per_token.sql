-- void:allow-destructive
-- Web Push subscriptions belong to an OAuth access token, as in Mastodon: one
-- per token, replaced by the next `POST /api/v1/push/subscription` with that
-- token, and gone when the token is revoked. Rows from before tokens existed
-- (keyed by account and endpoint) cannot be tied to a token, so they are
-- dropped; clients re-subscribe when they next sign in.
DROP TABLE push_subscriptions;

CREATE TABLE push_subscriptions (
  -- Mastodon reports the subscription id as a JSON number, so it stays a small integer.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  standard INTEGER NOT NULL DEFAULT 0,
  alerts_json TEXT NOT NULL DEFAULT '{}',
  policy TEXT NOT NULL DEFAULT 'all',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (access_token_id) REFERENCES oauth_access_tokens(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_push_subscriptions_account ON push_subscriptions (account_id, id);
