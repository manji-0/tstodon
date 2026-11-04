-- @param {String} $1:actorUri
-- @param {String} $2:updatedAt
UPDATE outbox_deliveries
SET kind = 'Failed', reason_kind = 'Permanent', attempt_count = 0, http_status = 410,
    updated_at = $2
WHERE kind = 'Queued'
  AND inbox_url IN (
    SELECT COALESCE(shared_inbox_uri, inbox_uri) FROM remote_actors WHERE actor_uri = $1
    UNION
    SELECT inbox_uri FROM remote_actors WHERE actor_uri = $1
  )
  AND NOT EXISTS (
    SELECT 1 FROM remote_actors other
    WHERE other.actor_uri <> $1
      AND (other.inbox_uri = outbox_deliveries.inbox_url
           OR other.shared_inbox_uri = outbox_deliveries.inbox_url)
  )
