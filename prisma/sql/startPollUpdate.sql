-- @param {String} $1:pollId
-- @param {String} $2:startedAt
-- Frees the poll's `Update` slot and records that a distribution started:
-- the votes counted before $2 are in it.
UPDATE polls SET update_queued_at = NULL, update_distributed_at = $2 WHERE id = $1
