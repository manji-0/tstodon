/**
 * SQL fragments selecting the remote actors whose domain a viewer must not see
 * statuses from, so a timeline query leaves them out before its `LIMIT`. Both
 * take the viewer id once (`''` for an anonymous viewer) and compare domains
 * case-insensitively, as `remote_actors.domain` is stored. An admin's
 * silence or suspension of a single actor hides it like its domain's.
 */
const hiddenActorsSql = (severities: string, moderations: string): string => `(
  SELECT actor_uri FROM remote_actors
  WHERE lower(domain) IN (
    SELECT lower(domain) FROM account_domain_blocks WHERE account_id = ?
    UNION
    SELECT lower(domain) FROM domain_blocks WHERE severity IN (${severities})
  )
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
