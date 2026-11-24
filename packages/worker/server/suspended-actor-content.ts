import type { OutboxJob, RemovedBoost } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, parseRows, type RepositoryError, runD1 } from "./d1";
import {
  listLocalBoostsOfRemoteActor,
  purgeRemoteActorConversationHides,
  purgeRemoteActorConversationReads,
  purgeRemoteActorNotificationDismissals,
  purgeRemoteActorNotifications,
  purgeRemoteActorRequestGroups,
  purgeRemoteActorStatusMutes,
} from "./generated/prisma/sql";
import { announceRemovedBoosts } from "./home-fan-out";
import { measureJobPage } from "./metrics";
import { RemoteAccountId } from "./remote-account-id";
import { removedBoostsFromRows } from "./removed-boost";
import type { TypedSqlLike } from "./typed-sql";

/**
 * What a domain suspension's actors had when it was recorded
 * (`remote_actor_content_purges`, migration 0176), deleted in bounded queued
 * pages, as Mastodon's `BlockDomainService#suspend_accounts!` runs
 * `DeleteAccountService` with `reserve_username` on each account: what
 * {@link emptyRemoteActorContentSql} empties for one actor, a page at a time.
 * One chain runs at a time, holding the lease
 * (`remote_actor_content_purge_lease`) that each page stamps.
 */

type PurgeJob = Extract<OutboxJob, { kind: "PurgeSuspendedActorContent" }>;

/** Rows of each kind one page deletes: a status takes its tags, mentions and media with it. */
export const SUSPENDED_CONTENT_PAGE = 100;

/**
 * Local boosts of the page's statuses one page deletes and announces: each
 * costs a stream publish and a home fan-out. A status goes once a page has
 * deleted the last of its local boosts.
 */
export const SUSPENDED_CONTENT_BOOST_PAGE = 20;

/** A lease no page stamped for this long belongs to a chain that stopped; another takes it. */
const LEASE_STALE_MINUTES = 10;

/**
 * The rows a suspension deletes of an actor, by the table and the column
 * naming the actor: the content it owns; the blocks, mutes and endorsements
 * local accounts hold of it (`blocked_by_relationships`,
 * `muted_by_relationships`, and the endorsements `Follow#remove_endorsements`
 * takes with its follows); and its blocks of them (`block_relationships`).
 */
const OWNED = [
  { table: "remote_statuses", actor: "actor_uri" },
  { table: "notifications", actor: "from_actor_uri" },
  { table: "remote_boosts", actor: "actor_uri" },
  { table: "remote_announces", actor: "remote_actor_uri" },
  { table: "remote_favourites", actor: "remote_actor_uri" },
  { table: "blocks", actor: "target_actor_uri" },
  { table: "mutes", actor: "target_actor_uri" },
  { table: "endorsements", actor: "target_actor_uri" },
  { table: "remote_blocks", actor: "actor_uri" },
] as const satisfies ReadonlyArray<{ table: string; actor: string }>;

type Owned = (typeof OWNED)[number];

const storedBy = (owned: Owned): string =>
  `t.${owned.actor} = p.actor_uri AND julianday(t.created_at) <= julianday(p.before)`;

/**
 * Up to `?1` rows of `owned` that the queued actors had by their purge's
 * `before`, by `column`. `CROSS JOIN` keeps the purges outermost: without
 * `ANALYZE` statistics SQLite may otherwise scan the content table.
 */
const pendingRowsSql = (owned: Owned, column: "rowid" | "id"): string =>
  `SELECT t.${column} AS id FROM remote_actor_content_purges p
   CROSS JOIN ${owned.table} t ON ${storedBy(owned)}
   LIMIT ?1`;

const hasPendingSql = (owned: Owned): string =>
  `EXISTS (SELECT 1 FROM ${owned.table} t WHERE ${storedBy(owned)})`;

/** The rows with nothing of their own to delete first: each goes by its rowid. */
const [STATUSES, NOTIFICATIONS, ...PLAIN] = OWNED;

/**
 * Mastodon's `purge_profile!`: the cached profile goes until a later fetch
 * of the actor writes it again.
 */
const PURGED_PROFILE = `display_name = '', profile_json = json_set(profile_json,
  '$.note', '', '$.avatarUrl', NULL, '$.headerUrl', NULL, '$.fields', json('[]'),
  '$.emojis', json('[]'), '$.locked', json('false'), '$.discoverable', json('false'))`;

/**
 * The statements that empty a remote actor and keep it, as Mastodon's
 * `BlockDomainService` runs `DeleteAccountService` with `reserve_username`
 * on each account a suspension suspends: the rows of {@link OWNED} (its
 * statuses with their tags, mentions and local boosts by cascade), the
 * thread mutes and conversation marks on its statuses, the requests its
 * notifications made (`NotificationRequest.where(from_account:)`; the
 * acceptances, Mastodon's `NotificationPermission`s, stay with the kept
 * account), its featured hashtags and its profile. The first one lists the
 * local boosts of its statuses, which go with them.
 * `PurgeSuspendedActorContent` deletes the same, in pages.
 */
export const emptyRemoteActorContentSql = (actorUri: string): ReadonlyArray<TypedSqlLike> => [
  listLocalBoostsOfRemoteActor(actorUri),
  purgeRemoteActorStatusMutes(actorUri),
  purgeRemoteActorConversationReads(actorUri),
  purgeRemoteActorConversationHides(actorUri),
  purgeRemoteActorNotificationDismissals(actorUri),
  purgeRemoteActorNotifications(actorUri),
  purgeRemoteActorRequestGroups(RemoteAccountId.encode(actorUri)),
  ...PLAIN.map((owned) => ({
    sql: `DELETE FROM ${owned.table} WHERE ${owned.actor} = $1`,
    values: [actorUri],
  })),
  { sql: `DELETE FROM ${STATUSES.table} WHERE ${STATUSES.actor} = $1`, values: [actorUri] },
  { sql: "DELETE FROM remote_featured_tags WHERE actor_uri = $1", values: [actorUri] },
  { sql: `UPDATE remote_actors SET ${PURGED_PROFILE} WHERE actor_uri = $1`, values: [actorUri] },
];

/** The local boosts of up to `?1` pending statuses, up to `?2`. */
const pendingBoostsSql = `SELECT id FROM statuses
  WHERE reblog_of_remote_id IN (${pendingRowsSql(STATUSES, "id")}) LIMIT ?2`;

const nothingPendingSql = OWNED.map((owned) => `NOT ${hasPendingSql(owned)}`).join(" AND ");

/** Purges with nothing left to delete, `?1` of them. */
const finishedSql = `SELECT p.actor_uri, p.before FROM remote_actor_content_purges p
  WHERE ${nothingPendingSql} LIMIT ?1`;

/** The reads a page makes over the content tables, for the plan test. */
export const purgeReadSqls: ReadonlyArray<string> = [
  ...OWNED.map((owned) => pendingRowsSql(owned, "rowid")),
  pendingBoostsSql,
  finishedSql,
];

const IdRow = z.object({ id: z.string() });
const FinishedRow = z.object({ actor_uri: z.string(), before: z.string() });

type Page = Readonly<{ boosts: ReadonlyArray<RemovedBoost>; left: boolean }>;

/**
 * Delete the next page: up to {@link SUSPENDED_CONTENT_BOOST_PAGE} local
 * boosts of up to {@link SUSPENDED_CONTENT_PAGE} statuses, the statuses
 * with none left (and the thread mutes and conversation marks on them), as
 * many notifications sent (with their dismissals), and as many rows of each
 * other kind of {@link OWNED}, then the purges that had nothing left, with
 * the notification requests their actors' notifications made, and the
 * featured hashtags and profile of each of those actors not fetched since
 * its purge's `before`. The rows are read first, so each statement of the
 * batch names the same rows. Stamps the lease, and gives it back once no
 * purge is left.
 */
const purgePage = (db: D1Database): Promise<Result<Page, RepositoryError>> =>
  runD1(async () => {
    const [statusRows, boostRows, notificationRows, finishedRows] = await db.batch([
      db.prepare(pendingRowsSql(STATUSES, "id")).bind(SUSPENDED_CONTENT_PAGE),
      db.prepare(pendingBoostsSql).bind(SUSPENDED_CONTENT_PAGE, SUSPENDED_CONTENT_BOOST_PAGE),
      db.prepare(pendingRowsSql(NOTIFICATIONS, "id")).bind(SUSPENDED_CONTENT_PAGE),
      db.prepare(finishedSql).bind(SUSPENDED_CONTENT_PAGE),
    ]);
    const ids = (rows: D1Result | undefined) =>
      jsonStringArray(parseRows(IdRow, rows?.results).map((row) => row.id));
    const finished = parseRows(FinishedRow, finishedRows?.results);
    const statuses = ids(statusRows);
    const finishedJson = JSON.stringify(
      finished.map((row) => ({
        actorUri: row.actor_uri,
        accountId: RemoteAccountId.encode(row.actor_uri),
        before: row.before,
      })),
    );
    const unfetchedSince = `SELECT a.actor_uri FROM json_each(?) f
      CROSS JOIN remote_actors a ON a.actor_uri = json_extract(f.value, '$.actorUri')
        AND julianday(a.fetched_at) <= julianday(json_extract(f.value, '$.before'))`;
    const inJson = "IN (SELECT value FROM json_each(?))";
    const unboosted = `IN (SELECT value FROM json_each(?) j
      WHERE NOT EXISTS (SELECT 1 FROM statuses b WHERE b.reblog_of_remote_id = j.value))`;
    const results = await db.batch([
      db
        .prepare("UPDATE remote_actor_content_purge_lease SET stamped_at = ? WHERE id = 1")
        .bind(nowIso()),
      db
        .prepare(`DELETE FROM statuses WHERE id ${inJson} RETURNING id, account_id`)
        .bind(ids(boostRows)),
      db
        .prepare(`DELETE FROM status_mutes WHERE thread_root_status_id ${unboosted}`)
        .bind(statuses),
      db
        .prepare(`DELETE FROM conversation_reads WHERE conversation_id ${unboosted}`)
        .bind(statuses),
      db
        .prepare(`DELETE FROM conversation_hides WHERE conversation_id ${unboosted}`)
        .bind(statuses),
      db.prepare(`DELETE FROM remote_statuses WHERE id ${unboosted}`).bind(statuses),
      db
        .prepare(`DELETE FROM notification_dismissals WHERE notification_id ${inJson}`)
        .bind(ids(notificationRows)),
      db.prepare(`DELETE FROM notifications WHERE id ${inJson}`).bind(ids(notificationRows)),
      ...PLAIN.map((owned) =>
        db
          .prepare(`DELETE FROM ${owned.table} WHERE rowid IN (${pendingRowsSql(owned, "rowid")})`)
          .bind(SUSPENDED_CONTENT_PAGE),
      ),
      db
        .prepare(
          `DELETE FROM notification_request_groups WHERE rowid IN (
             SELECT g.rowid FROM json_each(?) f
             CROSS JOIN notification_request_groups g
               ON g.from_account_id = json_extract(f.value, '$.accountId')
               AND julianday(g.created_at) <= julianday(json_extract(f.value, '$.before'))
           )`,
        )
        .bind(finishedJson),
      db
        .prepare(`DELETE FROM remote_featured_tags WHERE actor_uri IN (${unfetchedSince})`)
        .bind(finishedJson),
      db
        .prepare(
          `UPDATE remote_actors SET ${PURGED_PROFILE} WHERE actor_uri IN (${unfetchedSince})`,
        )
        .bind(finishedJson),
      db
        .prepare(
          `DELETE FROM remote_actor_content_purges WHERE rowid IN (
             SELECT p.rowid FROM remote_actor_content_purges p
             WHERE p.actor_uri ${inJson} AND ${nothingPendingSql}
           )`,
        )
        .bind(jsonStringArray(finished.map((row) => row.actor_uri))),
      db.prepare(
        `DELETE FROM remote_actor_content_purge_lease
         WHERE NOT EXISTS (SELECT 1 FROM remote_actor_content_purges)`,
      ),
      db.prepare("SELECT 1 AS id FROM remote_actor_content_purges LIMIT 1"),
    ]);
    return {
      boosts: removedBoostsFromRows(results[1]?.results),
      left: (results.at(-1)?.results ?? []).length > 0,
    };
  });

/**
 * Take the lease for a new chain while a purge is left and no chain stamped
 * the lease for {@link LEASE_STALE_MINUTES}. True when this call took it.
 */
export const claimSuspendedActorContentPurge = async (env: Env): Promise<boolean> => {
  const claimed = await runD1(async () =>
    parseRows(
      z.object({ id: z.number() }),
      (
        await env.DB.prepare(
          `INSERT INTO remote_actor_content_purge_lease (id, stamped_at)
           SELECT 1, ?1 WHERE EXISTS (SELECT 1 FROM remote_actor_content_purges)
           ON CONFLICT (id) DO UPDATE SET stamped_at = excluded.stamped_at
           WHERE julianday(remote_actor_content_purge_lease.stamped_at) < julianday(?1) - ?2 / 1440.0
           RETURNING id`,
        )
          .bind(nowIso(), LEASE_STALE_MINUTES)
          .all()
      ).results,
    ),
  );
  return claimed.isOk() && claimed.value.length > 0;
};

/** Start a chain, unless one holds the lease or nothing is left (the end of a recording). */
export const startSuspendedActorContentPurge = async (env: Env): Promise<void> => {
  if (!(await claimSuspendedActorContentPurge(env))) {
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send({ kind: "PurgeSuspendedActorContent" });
  } catch {
    console.error(JSON.stringify({ kind: "JobNotQueued", jobKind: "PurgeSuspendedActorContent" }));
  }
};

/**
 * Delete the next page of what the suspended actors had, whatever their
 * blocks have become since, and tell the boosters of their statuses that
 * those boosts are gone, as the per-account unsuspension does. A page queues
 * the next while a purge is left. A retry deletes what is left: each page
 * reads the state, not a cursor.
 */
export const processPurgeSuspendedActorContentJob = (env: Env, job: PurgeJob) =>
  measureJobPage(env, job.kind, async () => {
    const page = await purgePage(env.DB);
    if (page.isErr()) {
      return { outcome: "retry", size: -1, chained: false };
    }
    await announceRemovedBoosts(env, page.value.boosts);
    if (page.value.left) {
      await env.OUTBOX_PROCESS_QUEUE.send(job);
    }
    return { outcome: "ok", size: page.value.boosts.length, chained: page.value.left };
  });
