-- Remote statuses stored before hashtags were read as Mastodon reads them
-- (letters of any script, not only ASCII) are indexed under their ASCII tags
-- alone: `#日本語` is in neither `remote_status_tags` nor `tags`. This sends
-- them back to the `BackfillRemoteTags` job, which indexes a status with
-- `tags_indexed = 0` again, a page at a time.
--
-- The job reads the tags from the stored HTML (`htmlHashtags`): the note's
-- `tag` array, where a note that arrives now gets its tags from, is not
-- kept. So these rows end up with the hashtags their content reads as, as
-- they had before, now with the non-ASCII ones.
--
-- Only a status that can hold such a tag is sent back: its HTML has a
-- character outside ASCII (it has more bytes than characters) and a `#` or
-- `＃`. An entity such as `&#39;` counts as a `#`; the job indexes such a
-- status again to the tags it had.
--
-- Cost: one scan of `remote_statuses` that reads every row's HTML, and one
-- row write (with an entry in `idx_remote_statuses_tags_pending`, migration
-- 0133) per status sent back. Measured on local SQLite 3.53, not on D1, with
-- 1,000,000 rows of about 1 KB (1.1 GB): 6 seconds when a fifth are sent
-- back, 10 seconds when all are, 1 second when none is left to send back.
-- D1 ends a statement at 30 seconds. See docs/operations/runbook.md,
-- "Remote tag reindex (migration 0136)", for a database larger than that.
UPDATE remote_statuses SET tags_indexed = 0
WHERE tags_indexed = 1
  AND length(content_html) <> length(CAST(content_html AS BLOB))
  AND (instr(content_html, '#') > 0 OR instr(content_html, '＃') > 0);
