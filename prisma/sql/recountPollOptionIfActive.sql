-- @param {String} $1:pollId
-- @param {Int} $2:optionIndex
-- @param {String} $3:now
-- Set one option's tally to the number of its vote rows, local and remote.
-- Run in the batch that writes a vote: the count is taken where the row is
-- written, so two votes that read the poll at once both end up counted.
-- Nothing is written once the poll has ended at $3. D1 binds a number as a
-- real, hence the cast in the JSON path.
UPDATE polls SET options_json = json_set(
  options_json,
  '$[' || CAST($2 AS INTEGER) || '].votesCount',
  (SELECT COUNT(*) FROM poll_votes WHERE poll_id = $1 AND option_index = $2)
  + (SELECT COUNT(*) FROM remote_poll_votes WHERE poll_id = $1 AND option_index = $2)
)
WHERE id = $1 AND expires_at > $3
