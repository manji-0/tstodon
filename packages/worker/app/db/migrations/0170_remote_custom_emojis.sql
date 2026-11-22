-- The image this server last read for each custom emoji of a remote server,
-- as Mastodon keeps one `CustomEmoji` per shortcode and domain (the author's
-- account domain, `remote_actors.domain`). A note, or an actor's `Update` of
-- itself, that names another image for a known emoji replaces it, as
-- `process_emoji` fetches the image again when the URL differs, and the
-- `RefreshRemoteEmoji` job brings the copies stored with that server's posts,
-- their earlier versions and its actors' profiles to it. `revision` counts the
-- replacements, so a write tells a replaced emoji from a new one. The copies
-- stored before this table are brought to an emoji's image on its first
-- replacement.

CREATE TABLE remote_custom_emojis (
    domain TEXT NOT NULL,
    shortcode TEXT NOT NULL,
    image_url TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (domain, shortcode)
);
