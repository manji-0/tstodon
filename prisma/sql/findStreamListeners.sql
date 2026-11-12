-- Whether any hub holds a stream a home fan-out (`user`, `list`) or a public
-- fan-out (`public*`, `hashtag*`) could reach.
SELECT
  EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream IN ('user', 'list')) AS home,
  EXISTS (
    SELECT 1 FROM stream_subscriptions WHERE stream LIKE 'public%' OR stream LIKE 'hashtag%'
  ) AS public
