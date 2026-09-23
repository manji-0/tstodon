-- @param {String} $1:id
SELECT id, account_id, kind, reblog_of_id, in_reply_to_id, content_text, COALESCE(content_html, '') AS content_html, visibility, sensitive, COALESCE(spoiler_text, '') AS spoiler_text, language, created_at, poll_id
FROM statuses WHERE id = $1
