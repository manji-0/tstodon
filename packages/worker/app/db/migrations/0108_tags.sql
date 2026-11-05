-- Hashtag search needs the names of the tags this server knows, as Mastodon's
-- `tags` table: a tag is stored when a public or unlisted note, local or
-- remote, uses it, or an account follows or features it, and is never
-- removed. A direct or followers-only note's tags are left out, since search
-- shows every name to anyone. Names are stored as the tag timelines match
-- them: lowercase, without the `#`.

CREATE TABLE IF NOT EXISTS tags (
    name TEXT NOT NULL PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

-- Backfill from what is stored. Remote notes the cron has not indexed yet
-- add their tags when it does.
INSERT OR IGNORE INTO tags (name)
SELECT DISTINCT t.tag FROM remote_status_tags t
JOIN remote_statuses s ON s.id = t.status_id
WHERE s.visibility IN ('public', 'unlisted');
INSERT OR IGNORE INTO tags (name) SELECT DISTINCT tag_name FROM followed_tags;
INSERT OR IGNORE INTO tags (name) SELECT DISTINCT tag_name FROM featured_tags;

-- Local notes keep no tag index, so the `BackfillLocalNoteTags` job reads
-- their text a page at a time (src/local-tag-backfill.ts) instead of one
-- unbounded statement here, which could pass D1's query limits on a large
-- instance and hold the writer. Its cursor is the last note id read; once a
-- page comes back short, `completed_at` is set and the job stops.
CREATE TABLE IF NOT EXISTS backfill_cursors (
    name TEXT NOT NULL PRIMARY KEY,
    after_id TEXT NOT NULL DEFAULT '',
    completed_at TEXT
) WITHOUT ROWID;

INSERT OR IGNORE INTO backfill_cursors (name) VALUES ('local_note_tags');
