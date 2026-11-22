-- The image this server last read for each custom emoji of a remote server,
-- as Mastodon keeps one `CustomEmoji` per shortcode and domain (the author's
-- account domain, `remote_actors.domain`) and renders every post and profile
-- of the domain with it. `updated_at` is the tag's `updated` (Mastodon sends
-- the emoji's `updated_at`), else the date of the document that named it. A
-- document that names another image replaces it unless it is older, so a late
-- or retried delivery does not bring back an image the server has replaced.

CREATE TABLE remote_custom_emojis (
    domain TEXT NOT NULL,
    shortcode TEXT NOT NULL,
    image_url TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (domain, shortcode)
);

-- The copies of a domain's emoji kept with its posts, their earlier versions
-- and its actors' profiles are brought to the images above by one
-- `RefreshRemoteEmoji` chain per domain. `generation` counts the images
-- replaced; a chain refreshes for one generation and stops once a newer one
-- exists. `queued_generation` is the newest one a chain was started for, and
-- `queued_at` when that chain last ran a page; `refreshed_generation` the one
-- a chain finished. The hourly cron starts a chain for a domain whose newest
-- generation has none, or whose chain has not run a page for an hour.

CREATE TABLE remote_emoji_refreshes (
    domain TEXT PRIMARY KEY,
    generation INTEGER NOT NULL DEFAULT 0,
    queued_generation INTEGER NOT NULL DEFAULT 0,
    queued_at TEXT,
    refreshed_generation INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_remote_emoji_refreshes_unfinished
    ON remote_emoji_refreshes (domain)
    WHERE refreshed_generation < generation;

CREATE TRIGGER remote_custom_emojis_replaced
AFTER UPDATE OF image_url ON remote_custom_emojis
WHEN OLD.image_url IS NOT NEW.image_url
BEGIN
    -- Not `INSERT OR IGNORE`: the upsert that fires this trigger imposes its
    -- own conflict handling on it, which aborts on the existing row.
    INSERT INTO remote_emoji_refreshes (domain)
    SELECT NEW.domain
    WHERE NOT EXISTS (SELECT 1 FROM remote_emoji_refreshes WHERE domain = NEW.domain);
    UPDATE remote_emoji_refreshes SET generation = generation + 1 WHERE domain = NEW.domain;
END;
