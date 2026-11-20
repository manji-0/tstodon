-- @param {String} $1:fetchedAt
-- @param {String} $2:statusId
-- @param {String} $3:fetchedBefore
-- @param {String} $4:previousFetchedAt?
-- Mastodon's `Poll#possibly_stale?`: never fetched, or fetched before
-- `fetchedBefore` (a minute ago) and before the poll ends. Only from the
-- `previousFetchedAt` that was read, so a refresh that fails can put it back.
UPDATE remote_statuses SET poll_fetched_at = $1
WHERE id = $2
  AND poll_json IS NOT NULL
  AND poll_fetched_at IS $4
  AND (
    poll_fetched_at IS NULL
    OR (
      poll_fetched_at < $3
      AND (
        json_extract(poll_json, '$.ends.at') IS NULL
        OR poll_fetched_at < json_extract(poll_json, '$.ends.at')
      )
    )
  )
RETURNING id
