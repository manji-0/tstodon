-- Hashtag search needs the names of the tags this server knows, as Mastodon's
-- `tags` table: a tag is stored when a local or remote note uses it, or an
-- account follows or features it, and is never removed. Names are stored as
-- the tag timelines match them: lowercase, without the `#`.

CREATE TABLE IF NOT EXISTS tags (
    name TEXT NOT NULL PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

-- Backfill from what is stored. Remote notes the cron has not indexed yet
-- add their tags when it does.
INSERT OR IGNORE INTO tags (name) SELECT DISTINCT tag FROM remote_status_tags;
INSERT OR IGNORE INTO tags (name) SELECT DISTINCT tag_name FROM followed_tags;
INSERT OR IGNORE INTO tags (name) SELECT DISTINCT tag_name FROM featured_tags;

-- Local notes keep no tag index, so their tags are read from the text as
-- `extractHashtags` (src/status-discovery-store.ts) reads them: each `#`
-- followed by the longest run of ASCII letters, digits and `_`, lowercased.
-- `after_hash` holds the text after each `#`; `run` grows the tag one
-- character at a time while the next character is a tag character.
INSERT OR IGNORE INTO tags (name)
WITH RECURSIVE
  after_hash(rest) AS (
    SELECT substr(content_text, instr(content_text, '#') + 1)
    FROM statuses
    WHERE kind = 'LocalNote' AND instr(content_text, '#') > 0
    UNION ALL
    SELECT substr(rest, instr(rest, '#') + 1) FROM after_hash WHERE instr(rest, '#') > 0
  ),
  run(tag, rest) AS (
    SELECT '', rest FROM after_hash
    UNION ALL
    SELECT tag || substr(rest, 1, 1), substr(rest, 2)
    FROM run
    WHERE substr(rest, 1, 1) BETWEEN 'a' AND 'z'
       OR substr(rest, 1, 1) BETWEEN 'A' AND 'Z'
       OR substr(rest, 1, 1) BETWEEN '0' AND '9'
       OR substr(rest, 1, 1) = '_'
  )
SELECT DISTINCT lower(tag) FROM run
WHERE tag <> ''
  AND NOT (
    substr(rest, 1, 1) BETWEEN 'a' AND 'z'
    OR substr(rest, 1, 1) BETWEEN 'A' AND 'Z'
    OR substr(rest, 1, 1) BETWEEN '0' AND '9'
    OR substr(rest, 1, 1) = '_'
  );
