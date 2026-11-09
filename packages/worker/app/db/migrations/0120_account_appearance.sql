-- Mastodon's appearance preferences (`color_scheme` and `contrast` in its
-- user settings): the colour scheme and contrast the web app's HTML shell and
-- the Worker's own pages render as `data-color-scheme` / `data-contrast`.
-- An account without a row uses `auto` for both, as a signed-out visitor does.
CREATE TABLE account_appearance (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  color_scheme TEXT NOT NULL DEFAULT 'auto' CHECK (color_scheme IN ('auto', 'light', 'dark')),
  contrast TEXT NOT NULL DEFAULT 'auto' CHECK (contrast IN ('auto', 'high')),
  updated_at TEXT NOT NULL
);
