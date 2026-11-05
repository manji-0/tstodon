/**
 * SQL fragments selecting the remote actors whose domain a viewer must not see
 * statuses from, so a timeline query leaves them out before its `LIMIT`. Both
 * take the viewer id once (`''` for an anonymous viewer). A hostname without
 * its port is matched, so a block on `peer.test` covers `peer.test:8792` too.
 * The viewer's own block and an instance rule both name either the account
 * domain (`remote_actors.host`) or the actor URI's host (`uri_host`), as
 * `RemoteActor.onAnyHost`. An admin's silence or suspension of a single actor
 * hides it like its domain's.
 */
const hiddenActorsSql = (severities: string, moderations: string): string => `(
  SELECT r.actor_uri FROM remote_actors r
  JOIN (SELECT lower(domain) AS host FROM account_domain_blocks WHERE account_id = ?) b
    ON r.host = b.host OR r.uri_host = b.host
  UNION
  SELECT actor_uri FROM remote_actors
  WHERE host IN (SELECT lower(domain) FROM domain_blocks WHERE severity IN (${severities}))
    OR uri_host IN (SELECT lower(domain) FROM domain_blocks WHERE severity IN (${severities}))
  UNION
  SELECT actor_uri FROM remote_actor_moderation WHERE moderation IN (${moderations})
)`;

/** Domains the viewer blocks or the instance silences or suspends: public surfaces. */
export const DOMAIN_RESTRICTED_ACTORS_SQL = hiddenActorsSql(
  "'silence', 'suspend'",
  "'Silenced', 'Suspended'",
);

/** Domains the viewer blocks or the instance suspends: followers still see silenced ones. */
export const DOMAIN_SUSPENDED_ACTORS_SQL = hiddenActorsSql("'suspend'", "'Suspended'");
