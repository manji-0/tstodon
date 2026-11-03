-- @param {String} $1:entryId
-- @param {String} $2:afterHub
-- @param {Int} $3:limit
-- @param {Int} $4:anyTag
-- The public and hashtag subscriptions of the next page of hubs after
-- `afterHub`. A hashtag subscription is kept when the entry may carry its tag
-- (a loose match: the tag timeline decides), or always with `anyTag`.
WITH wanted AS (
  SELECT s.hub, s.stream, s.param FROM stream_subscriptions s
  WHERE s.hub > $2 AND (
    s.stream LIKE 'public%'
    OR (s.stream LIKE 'hashtag%' AND (
      $4 = 1
      OR EXISTS (SELECT 1 FROM remote_status_tags t WHERE t.status_id = $1 AND t.tag = s.param)
      OR EXISTS (
        SELECT 1 FROM statuses st WHERE st.id = $1 AND st.content_text LIKE '%#' || s.param || '%'
      )
    ))
  )
),
hubs AS (SELECT DISTINCT hub FROM wanted ORDER BY hub LIMIT $3)
SELECT hub, stream, param FROM wanted WHERE hub IN (SELECT hub FROM hubs) ORDER BY hub
