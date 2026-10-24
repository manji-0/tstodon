-- Mastodon's web UI, served from this Worker, calls the API with an access
-- token embedded in its HTML. That token belongs to the built-in web app and
-- to one Better Auth session: it goes away with the session (sign-out or
-- expiry), and `authenticate` refuses it once the session has expired.
ALTER TABLE oauth_access_tokens
  ADD COLUMN web_session_id TEXT REFERENCES "session" ("id") ON DELETE CASCADE;
CREATE UNIQUE INDEX idx_oauth_access_tokens_web_session
  ON oauth_access_tokens (web_session_id) WHERE web_session_id IS NOT NULL;

-- The web UI's own preferences (`PUT /api/web/settings`), stored as it sends
-- them and handed back in its initial state.
CREATE TABLE web_settings (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
