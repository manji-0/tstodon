-- @param {String} $1:statusId
SELECT id, status_id, multiple, expires_at, options_json, hide_totals,
  (SELECT COUNT(*) FROM (
    SELECT account_id FROM poll_votes WHERE poll_id = polls.id
    UNION
    SELECT actor_uri FROM remote_poll_votes WHERE poll_id = polls.id
  )) AS voters_count
FROM polls WHERE status_id = $1
