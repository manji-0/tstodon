-- @param {String} $1:viewerId
-- @param {String} $2:accountIdsJson
-- @param {String} $3:actorUrisJson
-- Mastodon's `StatusFilter#silenced_account?`: the authors among the local accounts of $2 and
-- the remote actors of $3 that are silenced and that the viewer ($1, '' when anonymous) does not
-- follow (accepted), nor is. A remote actor is silenced on its own or by a silence of its
-- account domain or its URI's host, as `RemoteActor.onAnyHost`. Each host follows its most
-- specific rule, as Mastodon's `DomainBlock.rule_for`: the host and each domain above it
-- (`domain_variants`) are sought by key, a block's domain being stored lower case (`Hostname`,
-- migration 0160), and the longest one found decides. Suspension is not checked here: a
-- suspended author's status is not rendered at all.
SELECT m.account_id AS author FROM account_moderation AS m
WHERE m.account_id IN (SELECT value FROM json_each($2))
  AND m.moderation = 'Silenced'
  AND m.account_id <> $1
  AND NOT EXISTS (
    SELECT 1 FROM follows AS f
    WHERE f.follower_account_id = $1 AND f.target_account_id = m.account_id
      AND f.kind = 'Accepted'
  )
UNION ALL
SELECT r.actor_uri AS author FROM remote_actors AS r
WHERE r.actor_uri IN (SELECT value FROM json_each($3))
  AND (
    EXISTS (
      SELECT 1 FROM remote_actor_moderation AS am
      WHERE am.actor_uri = r.actor_uri AND am.moderation = 'Silenced'
    )
    OR 'silence' IN (
      SELECT (
        SELECT d.severity FROM domain_blocks AS d
        WHERE d.domain IN (
          WITH RECURSIVE variants(domain) AS (
            SELECT hosts.host
            UNION ALL
            SELECT substr(domain, instr(domain, '.') + 1) FROM variants WHERE instr(domain, '.') > 0
          )
          SELECT domain FROM variants
        )
        ORDER BY length(d.domain) DESC
        LIMIT 1
      )
      FROM (SELECT r.host AS host UNION ALL SELECT r.uri_host) AS hosts
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM outbound_follows AS o
    WHERE o.account_id = $1 AND o.actor_uri = r.actor_uri AND o.state = 'Accepted'
  )
