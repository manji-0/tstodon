-- @param {String} $1:afterId
-- @param {String} $2:throughId
-- @param {String} $3:updatedBefore
-- @param {String} $4:localStatusUriPrefix
-- Delete the remote statuses of one retention slice, ids in ($1, $2], that
-- were last written before $3 and that nothing local needs. Each NOT EXISTS
-- is one equality on an indexed column. A direct status is never deleted.
-- Kept: statuses by an actor a local account follows (any state), that
-- follows one, or that was reported; statuses a local account favourited,
-- bookmarked, boosted, replied to, voted in, or muted the thread of; ones
-- quoting a local status or quoted by any status; ones mentioning a local
-- account (with the vote and quote rows, this keeps every status a
-- notification points at); replies to a local status ($4 starts every local
-- status URI) and replies to such a reply; ones a remaining remote status
-- replies to (its parent goes on a later pass, once the reply has gone); and
-- ones a followed or following actor boosted. Returns the deleted ids
-- (D1's `changes` also counts the cascaded rows). Deleting cascades to the
-- status's tags, edits, remote mentions, pins and the boosts of it.
DELETE FROM remote_statuses AS rs
WHERE rs.id > $1 AND rs.id <= $2
  AND rs.updated_at < $3
  AND rs.visibility <> 'direct'
  AND (rs.in_reply_to_uri IS NULL OR substr(rs.in_reply_to_uri, 1, length($4)) <> $4)
  AND NOT EXISTS (SELECT 1 FROM outbound_follows f WHERE f.actor_uri = rs.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM remote_follows f WHERE f.remote_actor_uri = rs.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.target_actor_uri = rs.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM favourites f WHERE f.remote_status_id = rs.id)
  AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.remote_status_id = rs.id)
  AND NOT EXISTS (SELECT 1 FROM statuses s WHERE s.reblog_of_remote_id = rs.id)
  AND NOT EXISTS (SELECT 1 FROM statuses s WHERE s.in_reply_to_uri = rs.object_uri)
  AND NOT EXISTS (SELECT 1 FROM remote_statuses c WHERE c.in_reply_to_uri = rs.object_uri)
  AND NOT EXISTS (
    SELECT 1 FROM remote_statuses p
    WHERE p.object_uri = rs.in_reply_to_uri
      AND substr(p.in_reply_to_uri, 1, length($4)) = $4
  )
  AND NOT EXISTS (SELECT 1 FROM status_quotes q WHERE q.quoted_remote_status_id = rs.id)
  AND NOT EXISTS (
    SELECT 1 FROM status_quotes q
    WHERE q.remote_status_id = rs.id AND q.quoted_status_id IS NOT NULL
  )
  AND NOT EXISTS (SELECT 1 FROM remote_poll_own_votes v WHERE v.status_id = rs.id)
  AND NOT EXISTS (SELECT 1 FROM remote_status_mentions m WHERE m.status_id = rs.id)
  AND NOT EXISTS (SELECT 1 FROM status_mutes m WHERE m.thread_root_status_id = rs.id)
  AND NOT EXISTS (
    SELECT 1 FROM remote_boosts b
    WHERE b.remote_status_id = rs.id
      AND (
        EXISTS (SELECT 1 FROM outbound_follows f WHERE f.actor_uri = b.actor_uri)
        OR EXISTS (SELECT 1 FROM remote_follows f WHERE f.remote_actor_uri = b.actor_uri)
      )
  )
RETURNING id
