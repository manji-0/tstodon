-- An announcement's text as an admin wrote it, which `GET /api/v1/announcements`
-- renders on each read as Mastodon's `REST::AnnouncementSerializer#content`
-- does (`linkify(text)`): its URLs, hashtags and the mentions of known accounts
-- become links. NULL for an announcement written as HTML (the admin API's
-- `content`) and for those stored before this column, whose `content` is
-- served as it is.
ALTER TABLE announcements ADD COLUMN text TEXT;
