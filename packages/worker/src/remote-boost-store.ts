import { RemoteBoost, type RemoteBoostValue, Visibility } from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import {
  deleteRemoteBoostByActivity as deleteRemoteBoostByActivitySql,
  findRemoteBoostById as findRemoteBoostByIdSql,
  insertRemoteBoost as insertRemoteBoostSql,
} from "./generated/prisma/sql";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { feedFollowSql, type FollowedFeed } from "./followed-feed";
import { SUPPRESSED_ACCOUNT_IDS_SQL } from "./block-mute-store";
import { visibilitySql } from "./sql-enums";
import { queryTyped } from "./typed-sql";

const RemoteBoostRowSchema = z.object({
  id: z.string().min(1),
  actor_uri: z.string().min(1),
  activity_id: z.string().min(1),
  local_status_id: z.string().nullable(),
  remote_status_id: z.string().nullable(),
  visibility: z.string().min(1),
  published_at: z.string().min(1),
});

const parseRemoteBoostRow = schemaResult(RemoteBoostRowSchema);

/** A stored boost, or nothing for a row that does not read back as one. */
const remoteBoostFromRow = (raw: unknown): RemoteBoostValue | undefined => {
  const row = parseRemoteBoostRow(raw);
  if (row.isErr()) {
    return undefined;
  }
  const visibility = Visibility.fromMastodon(row.value.visibility);
  const boost = RemoteBoost.parse({
    kind: "RemoteBoost",
    id: row.value.id,
    actorUri: row.value.actor_uri,
    activityId: row.value.activity_id,
    target: row.value.local_status_id
      ? { kind: "LocalStatus", statusId: row.value.local_status_id }
      : { kind: "RemoteStatus", statusId: row.value.remote_status_id },
    visibility: visibility.isOk() ? visibility.value : undefined,
    publishedAt: row.value.published_at,
  });
  return boost.isOk() ? boost.value : undefined;
};

/** Record a boost; `true` only when it is new (a redelivery or a second boost of the status answers `false`). */
export const insertRemoteBoost = async (
  db: D1Database,
  boost: RemoteBoostValue,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      insertRemoteBoostSql(
        boost.id,
        boost.actorUri,
        boost.activityId,
        boost.target.kind === "LocalStatus" ? boost.target.statusId : null,
        boost.target.kind === "RemoteStatus" ? boost.target.statusId : null,
        visibilitySql(boost.visibility),
        boost.publishedAt,
        nowIso(),
      ),
    );
    return rows.length > 0;
  });

/**
 * Drop the boost an `Undo` names, only when `actorUri` (the Undo's signer)
 * made it. Resolves to the dropped boost's id, if there was one.
 */
export const deleteRemoteBoostByActivity = async (
  db: D1Database,
  activityId: string,
  actorUri: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      deleteRemoteBoostByActivitySql(activityId, actorUri),
    );
    return rows[0]?.id;
  });

export const findRemoteBoostById = async (
  db: D1Database,
  id: string,
): Promise<Result<RemoteBoostValue | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findRemoteBoostByIdSql(id));
    return rows[0] === undefined ? undefined : remoteBoostFromRow(rows[0]);
  });

/** Remote actors on a domain the viewer blocks or the instance suspends. Binds: (viewerId). */
const DOMAIN_HIDDEN_ACTORS_SQL = `(
  SELECT actor_uri FROM remote_actors
  WHERE lower(domain) IN (
    SELECT lower(domain) FROM account_domain_blocks WHERE account_id = ?
    UNION
    SELECT lower(domain) FROM domain_blocks WHERE severity = 'suspend'
  )
)`;

/** Actor URIs (local or remote) the viewer blocks or mutes. Binds: (viewerId, viewerId, now). */
const HIDDEN_ACTOR_URIS_SQL = `(
  SELECT target_actor_uri FROM blocks WHERE blocker_account_id = ?
  UNION
  SELECT target_actor_uri FROM mutes
  WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)
)`;

/**
 * Boosts on one of the account's followed feeds (home or a list): those of
 * remote actors it follows (accepted, with reblogs shown) on that feed, newest
 * first. The boosted status must be a public or unlisted one; a block or mute
 * of the booster or of the original author hides the boost, as does a domain
 * block or suspension of either.
 */
export const listFollowedRemoteBoosts = async (
  db: D1Database,
  accountId: string,
  feed: FollowedFeed,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<RemoteBoostValue[], RepositoryError>> =>
  runD1(async () => {
    const now = nowIso();
    const { where, order, binds } = idCursorFragment(cursor);
    const follows = feedFollowSql(feed);
    const { results } = await db
      .prepare(
        `SELECT * FROM (
           SELECT b.id, b.actor_uri, b.activity_id, b.local_status_id, b.remote_status_id,
                  b.visibility, b.published_at
           FROM remote_boosts b
           JOIN outbound_follows f
             ON f.actor_uri = b.actor_uri AND f.account_id = ? AND f.state = 'Accepted'
                AND f.reblogs <> 0 ${follows.sql}
           LEFT JOIN statuses ls ON ls.id = b.local_status_id
           LEFT JOIN remote_statuses rs ON rs.id = b.remote_status_id
           WHERE COALESCE(ls.visibility, rs.visibility) IN ('public', 'unlisted')
             AND (ls.id IS NULL OR ls.account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL})
             AND b.actor_uri NOT IN ${HIDDEN_ACTOR_URIS_SQL}
             AND COALESCE(rs.actor_uri, '') NOT IN ${HIDDEN_ACTOR_URIS_SQL}
             AND b.actor_uri NOT IN ${DOMAIN_HIDDEN_ACTORS_SQL}
             AND COALESCE(rs.actor_uri, '') NOT IN ${DOMAIN_HIDDEN_ACTORS_SQL}
         ) WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(
        accountId,
        ...follows.binds,
        // `SUPPRESSED_ACCOUNT_IDS_SQL` takes the viewer three times and its clock.
        accountId,
        accountId,
        accountId,
        now,
        accountId,
        accountId,
        now,
        accountId,
        accountId,
        now,
        accountId,
        accountId,
        ...binds,
        limit,
      )
      .all();
    return (results ?? []).flatMap((raw) => remoteBoostFromRow(raw) ?? []);
  });

/**
 * A remote actor's boosts on its profile, newest first, as the viewer may see
 * them: a followers-only boost only by the actor's accepted followers. The
 * boosted status must be public or unlisted, and a block or mute of its
 * author, or a domain block or suspension of that author's domain, hides it.
 */
export const listActorRemoteBoosts = async (
  db: D1Database,
  actorUri: string,
  viewerId: string | undefined,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<RemoteBoostValue[], RepositoryError>> =>
  runD1(async () => {
    const viewer = viewerId ?? "";
    const now = nowIso();
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT * FROM (
           SELECT b.id, b.actor_uri, b.activity_id, b.local_status_id, b.remote_status_id,
                  b.visibility, b.published_at
           FROM remote_boosts b
           LEFT JOIN statuses ls ON ls.id = b.local_status_id
           LEFT JOIN remote_statuses rs ON rs.id = b.remote_status_id
           WHERE b.actor_uri = ?
             AND (b.visibility IN ('public', 'unlisted') OR EXISTS (
               SELECT 1 FROM outbound_follows f
               WHERE f.account_id = ? AND f.actor_uri = b.actor_uri AND f.state = 'Accepted'
             ))
             AND COALESCE(ls.visibility, rs.visibility) IN ('public', 'unlisted')
             AND (ls.id IS NULL OR ls.account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL})
             AND COALESCE(rs.actor_uri, '') NOT IN ${HIDDEN_ACTOR_URIS_SQL}
             AND COALESCE(rs.actor_uri, '') NOT IN ${DOMAIN_HIDDEN_ACTORS_SQL}
         ) WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(
        actorUri,
        viewer,
        // `SUPPRESSED_ACCOUNT_IDS_SQL` takes the viewer three times and its clock.
        viewer,
        viewer,
        viewer,
        now,
        viewer,
        viewer,
        now,
        viewer,
        ...binds,
        limit,
      )
      .all();
    return (results ?? []).flatMap((raw) => remoteBoostFromRow(raw) ?? []);
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([RemoteBoostRowSchema]);
