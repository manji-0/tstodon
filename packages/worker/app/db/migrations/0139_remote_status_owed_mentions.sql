-- The local accounts an edit newly mentions, as a JSON array of account ids,
-- on its `Edited` marker. The redelivery that finishes the edit cannot work
-- them out again: the failed delivery may have written their mention rows,
-- which is how a first delivery tells a new mention from one the note had.
-- Empty for a `Created` marker, whose every mention is new.
ALTER TABLE remote_status_owed ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]';
