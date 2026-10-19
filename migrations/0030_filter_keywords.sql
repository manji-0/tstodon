-- v2 filters own a list of keywords (`keywords_json`) so the keyword
-- sub-resources have real rows; `phrase` stays as the v1 view of the first one.

ALTER TABLE filters ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]';
