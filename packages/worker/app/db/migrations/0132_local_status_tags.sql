-- Local tag timelines, an account's `tagged` filter, hashtag streams and the
-- admin tag measures matched a tag with `content_text LIKE '%#name%'`, a
-- second rule beside `extractHashtags`: `#category` listed under `cat`,
-- `(#cat)` (no tag) listed, and a full-width `＃ＣＡＴ` (tag `cat`) did not.
-- This index holds the tags `extractHashtags` finds in a local note, of every
-- visibility (the queries keep their own visibility checks), as
-- `remote_status_tags` holds a remote note's. Publishing and editing write
-- it; the status's delete removes its rows.

CREATE TABLE IF NOT EXISTS local_status_tags (
    status_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (status_id, tag),
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_local_status_tags_tag
    ON local_status_tags (tag, status_id);

-- Notes stored before this migration (or by the old worker during the
-- deploy) are indexed by the `BackfillLocalNoteTags` job a page at a time
-- (server/local-tag-backfill.ts), from a cursor of its own: the
-- `local_note_tags` one of migration 0108 is complete on a running instance.
INSERT OR IGNORE INTO backfill_cursors (name) VALUES ('local_status_tags');
