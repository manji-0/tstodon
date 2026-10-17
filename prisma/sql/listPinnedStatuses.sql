-- @param {String} $1:accountId
SELECT
  s.id, s.account_id, s.kind, s.reblog_of_id, s.in_reply_to_id, s.content_text,
  COALESCE(s.content_html, '') AS content_html, s.visibility, s.sensitive,
  COALESCE(s.spoiler_text, '') AS spoiler_text, s.language, s.created_at, s.updated_at, s.poll_id
FROM status_pins sp
JOIN statuses s ON s.id = sp.status_id
WHERE sp.account_id = $1
ORDER BY sp.created_at DESC, s.id DESC
