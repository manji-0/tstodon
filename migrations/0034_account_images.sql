-- Avatar and header images live in the media bucket; the profile keeps their
-- object keys and content types.

ALTER TABLE account_profiles ADD COLUMN avatar_object_key TEXT;
ALTER TABLE account_profiles ADD COLUMN avatar_content_type TEXT;
ALTER TABLE account_profiles ADD COLUMN header_object_key TEXT;
ALTER TABLE account_profiles ADD COLUMN header_content_type TEXT;
