import type { OutboxJob, RemovedBoost } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, parseRows, type RepositoryError, runD1 } from "./d1";
import { announceRemovedBoosts } from "./home-fan-out";
import { measureJobPage } from "./metrics";
import { removedBoostsFromRows } from "./removed-boost";

/**
 * The content a domain suspension's actors had when it was recorded
 * (`remote_actor_content_purges`, migration 0176), deleted in bounded queued
 * pages, as Mastodon's `BlockDomainService#suspend_accounts!` runs
 * `DeleteAccountService` with `reserve_username` on each account: what
 * `emptyRemoteActorContentSql` empties for one actor, a page at a time.
 */

type PurgeJob = Extract<OutboxJob, { kind: "PurgeSuspendedActorContent" }>;

/** Rows of each kind one page deletes: a status takes its tags, mentions, media and local boosts with it. */
export const SUSPENDED_CONTENT_PAGE = 100;

/** The content an actor owns, by the table and the column naming the actor. */
const OWNED = [
  { table: "remote_statuses", actor: "actor_uri" },
  { table: "notifications", actor: "from_actor_uri" },
  { table: "remote_boosts", actor: "actor_uri" },
  { table: "remote_announces", actor: "remote_actor_uri" },
  { table: "remote_favourites", actor: "remote_actor_uri" },
] as const satisfies ReadonlyArray<{ table: string; actor: string }>;

type Owned = (typeof OWNED)[number];

/** Up to `?1` rows of `owned` that the queued actors had by their purge's `before`, by `column`. */
const pendingRowsSql = (owned: Owned, column: "rowid" | "id"): string =>
  `SELECT t.${column} AS id FROM remote_actor_content_purges p
   JOIN ${owned.table} t ON t.${owned.actor} = p.actor_uri
     AND julianday(t.created_at) <= julianday(p.before)
   LIMIT ?1`;

const hasPendingSql = (owned: Owned): string =>
  `EXISTS (SELECT 1 FROM ${owned.table} t WHERE t.${owned.actor} = p.actor_uri
     AND julianday(t.created_at) <= julianday(p.before))`;

const [STATUSES, NOTIFICATIONS, ...ENGAGEMENTS] = OWNED;

const IdRow = z.object({ id: z.string() });

/**
 * Delete the next page: up to {@link SUSPENDED_CONTENT_PAGE} statuses (the
 * thread mutes and conversation marks on them with them, and their local
 * boosts by cascade), notifications sent (with their dismissals), and each
 * kind of boost, favourite and announce, then the purges with nothing left.
 * The statuses and notifications are read first, so each statement of the
 * batch names the same rows. Resolves to the local boosts deleted and
 * whether any purge is left.
 */
const purgePage = (
  db: D1Database,
): Promise<
  Result<Readonly<{ boosts: ReadonlyArray<RemovedBoost>; left: boolean }>, RepositoryError>
> =>
  runD1(async () => {
    const [statusRows, notificationRows] = await db.batch([
      db.prepare(pendingRowsSql(STATUSES, "id")).bind(SUSPENDED_CONTENT_PAGE),
      db.prepare(pendingRowsSql(NOTIFICATIONS, "id")).bind(SUSPENDED_CONTENT_PAGE),
    ]);
    const statuses = jsonStringArray(parseRows(IdRow, statusRows?.results).map((row) => row.id));
    const notifications = jsonStringArray(
      parseRows(IdRow, notificationRows?.results).map((row) => row.id),
    );
    const inJson = "IN (SELECT value FROM json_each(?))";
    const results = await db.batch([
      db
        .prepare(
          `SELECT id, account_id FROM statuses
           WHERE kind = 'LocalReblog' AND reblog_of_remote_id ${inJson}`,
        )
        .bind(statuses),
      db.prepare(`DELETE FROM status_mutes WHERE thread_root_status_id ${inJson}`).bind(statuses),
      db.prepare(`DELETE FROM conversation_reads WHERE conversation_id ${inJson}`).bind(statuses),
      db.prepare(`DELETE FROM conversation_hides WHERE conversation_id ${inJson}`).bind(statuses),
      db.prepare(`DELETE FROM remote_statuses WHERE id ${inJson}`).bind(statuses),
      db
        .prepare(`DELETE FROM notification_dismissals WHERE notification_id ${inJson}`)
        .bind(notifications),
      db.prepare(`DELETE FROM notifications WHERE id ${inJson}`).bind(notifications),
      ...ENGAGEMENTS.map((owned) =>
        db
          .prepare(`DELETE FROM ${owned.table} WHERE rowid IN (${pendingRowsSql(owned, "rowid")})`)
          .bind(SUSPENDED_CONTENT_PAGE),
      ),
      db
        .prepare(
          `DELETE FROM remote_actor_content_purges WHERE actor_uri IN (
             SELECT p.actor_uri FROM remote_actor_content_purges p
             WHERE ${OWNED.map((owned) => `NOT ${hasPendingSql(owned)}`).join(" AND ")}
             LIMIT ?
           )`,
        )
        .bind(SUSPENDED_CONTENT_PAGE),
      db.prepare("SELECT 1 AS id FROM remote_actor_content_purges LIMIT 1"),
    ]);
    return {
      boosts: removedBoostsFromRows(results[0]?.results),
      left: (results.at(-1)?.results ?? []).length > 0,
    };
  });

/** Whether any suspended actor's content waits to be deleted (hourly cron). */
export const hasSuspendedActorContent = async (env: Env): Promise<boolean> => {
  const found = await runD1(async () =>
    parseRows(
      z.object({ one: z.number() }),
      (await env.DB.prepare("SELECT 1 AS one FROM remote_actor_content_purges LIMIT 1").all())
        .results,
    ),
  );
  return found.isOk() && found.value.length > 0;
};

/**
 * Delete the next page of what the suspended actors had, whatever their
 * blocks have become since, and tell the boosters of their statuses that
 * those boosts are gone, as the per-account unsuspension does. A page queues
 * the next while a purge is left. A retry, or a second chain, deletes what
 * is left: each page reads the state, not a cursor.
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
