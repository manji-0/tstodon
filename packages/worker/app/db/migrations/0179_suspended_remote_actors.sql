-- The remote actors a fetch of their own document finds suspended: an
-- admin's suspension, or one an instance domain block recorded and no admin
-- lifted (`remote_actor_domain_limits`). The writes of a fetched actor keep
-- the cached profile of these, as Mastodon's `ProcessAccountService` skips
-- `set_immediate_attributes!` and `set_fetchable_attributes!` for a
-- suspended account. A suspension that covers an actor's host now is left
-- out: a fetch of such an actor is refused before it writes.
CREATE VIEW suspended_remote_actors AS
SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended'
UNION ALL
SELECT l.actor_uri FROM remote_actor_domain_limits l
JOIN domain_blocks d ON d.id = l.domain_block_id
WHERE d.severity = 'suspend'
  AND NOT EXISTS (
    SELECT 1 FROM remote_actor_domain_lifts x
    WHERE x.domain_block_id = l.domain_block_id AND x.actor_uri = l.actor_uri
      AND x.severity = 'suspend'
  );
