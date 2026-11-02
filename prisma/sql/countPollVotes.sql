-- @param {String} $1:pollId
SELECT
  (SELECT COUNT(*) FROM poll_votes WHERE poll_id = $1)
  + (SELECT COUNT(*) FROM remote_poll_votes WHERE poll_id = $1) AS count
