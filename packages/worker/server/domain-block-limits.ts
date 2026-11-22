import { AccountStanding, Hostname, type OutboxJob } from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import { z } from "zod";
import { findDomainBlockById } from "./admin-domain-block-store";
import { jsonStringArray, parseRows, runD1, type RepositoryError } from "./d1";
import { hostKeyRange } from "./host-key";
import { startJob } from "./inline-job";
import { measureJobPage } from "./metrics";

/**
 * The limitation an instance domain block keeps on the actors it found when
 * it was made (`remote_actor_domain_limits`, migration 0169), as Mastodon's
 * `BlockDomainService` stores `silenced_at` / `suspended_at` on each account
 * at or under the domain. SQL reads it through `remote_actor_domain_rules`;
 * the Worker's own per-actor checks read {@link listDomainSuspendedActors}.
 */

type RecordJob = Extract<OutboxJob, { kind: "RecordDomainBlockLimits" }>;
type Cursor = RecordJob["cursor"];

/** Where a block's recording starts: the actors' account domains, from the first key. */
const START: Cursor = { host: "AccountDomain", afterKey: "", afterRowId: 0 };

/** Rows one page records or deletes. */
const PAGE = 500;

const KEY_COLUMNS = {
  AccountDomain: "host_key",
  UriHost: "uri_host_key",
} as const satisfies Record<Cursor["host"], string>;

/**
 * The next page of actors whose `host` key is in the range `[?2, ?3)` after
 * the cursor `(?4, ?5)`, `?6` of them, in the order the key's index holds
 * them (key, then row id), so a page reads its own rows and no earlier ones.
 */
export const recordPageSql = (host: Cursor["host"]): string => {
  const key = KEY_COLUMNS[host];
  return `SELECT rowid AS row_id, ${key} AS key, actor_uri, created_at FROM remote_actors
    WHERE ${key} >= ?2 AND ${key} < ?3 AND (${key}, rowid) > (?4, ?5)
    ORDER BY ${key}, rowid LIMIT ?6`;
};

const PageRow = z.object({ row_id: z.number(), key: z.string(), actor_uri: z.string() });

/**
 * Record the actors of the page after `cursor` under block `blockId`, unless
 * the block no longer silences or suspends by the time the statement runs,
 * so a block changed or removed meanwhile leaves no rows. With `seenBy`,
 * only the actors first seen by then. Resolves to the cursor after the page,
 * `undefined` once both hosts are read.
 */
const recordPage = (
  db: D1Database,
  blockId: string,
  domain: Hostname,
  cursor: Cursor,
  seenBy: string | undefined,
): Promise<Result<Cursor | undefined, RepositoryError>> =>
  runD1(async () => {
    const { from, to } = hostKeyRange(domain);
    const page = recordPageSql(cursor.host);
    const binds = [blockId, from, to, cursor.afterKey, cursor.afterRowId, PAGE];
    const [, read] = await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO remote_actor_domain_limits (domain_block_id, actor_uri)
           SELECT ?1, p.actor_uri FROM (${page}) p
           WHERE EXISTS (
             SELECT 1 FROM domain_blocks WHERE id = ?1 AND severity IN ('silence', 'suspend')
           ) AND (?7 IS NULL OR julianday(p.created_at) <= julianday(?7))`,
        )
        .bind(...binds, seenBy ?? null),
      db.prepare(page).bind(...binds),
    ]);
    const rows = parseRows(PageRow, read?.results);
    const last = rows.at(-1);
    if (last !== undefined && rows.length === PAGE) {
      return { host: cursor.host, afterKey: last.key, afterRowId: last.row_id };
    }
    return cursor.host === "AccountDomain" ? { ...START, host: "UriHost" } : undefined;
  });

/** Statements that forget what the admin and the backfill kept for a block applied again or lifted. */
const forgetBlockState = (db: D1Database, blockId: string): D1PreparedStatement[] => [
  db.prepare("DELETE FROM remote_actor_domain_lifts WHERE domain_block_id = ?").bind(blockId),
  db.prepare("DELETE FROM domain_block_limit_backfills WHERE domain_block_id = ?").bind(blockId),
];

/** Delete the next page of rows a lifted block left, with its lifts and backfill. */
const forgetPage = (db: D1Database, blockId: string): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const [deleted] = await db.batch([
      db
        .prepare(
          `DELETE FROM remote_actor_domain_limits WHERE rowid IN (
             SELECT rowid FROM remote_actor_domain_limits WHERE domain_block_id = ? LIMIT ?
           )`,
        )
        .bind(blockId, PAGE),
      ...forgetBlockState(db, blockId),
    ]);
    return deleted?.meta.changes ?? 0;
  });

/**
 * Run one page of {@link startDomainBlockLimits}: record while the block
 * silences or suspends, delete once it is a `noop` or gone. A page queues the
 * next one. A retry runs the same page again, and its rows are recorded
 * once, so a retry or a second job for the same block converges.
 */
export const processRecordDomainBlockLimitsJob = (env: Env, job: RecordJob) =>
  measureJobPage(env, job.kind, async () => {
    const found = await findDomainBlockById(env.DB, job.domainBlockId);
    if (found.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    const block = found.value;
    if (block === undefined || block.severity === "noop") {
      const forgotten = await forgetPage(env.DB, job.domainBlockId);
      if (forgotten.isErr()) {
        return { outcome: "retry", size: 0, chained: false };
      }
      const chained = forgotten.value === PAGE;
      if (chained) {
        await env.OUTBOX_PROCESS_QUEUE.send(job);
      }
      return { outcome: "ok", size: forgotten.value, chained, step: "Forget" };
    }
    const next = await recordPage(
      env.DB,
      block.id,
      Hostname.ofAuthority(block.domain),
      job.cursor,
      job.seenBy,
    );
    if (next.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    if (next.value !== undefined) {
      await env.OUTBOX_PROCESS_QUEUE.send({ ...job, cursor: next.value });
    } else if (job.seenBy !== undefined) {
      const done = await runD1(() =>
        env.DB.prepare("DELETE FROM domain_block_limit_backfills WHERE domain_block_id = ?")
          .bind(block.id)
          .run(),
      );
      if (done.isErr()) {
        return { outcome: "retry", size: 0, chained: false };
      }
    }
    return { outcome: "ok", size: -1, chained: next.value !== undefined, step: job.cursor.host };
  });

const recordJob = (domainBlockId: string): RecordJob => ({
  kind: "RecordDomainBlockLimits",
  domainBlockId,
  cursor: START,
});

const backfillJob = (backfill: Backfill): RecordJob => ({
  ...recordJob(backfill.id),
  seenBy: backfill.seen_by,
});

/**
 * Bring the actors a block limits in line with the block as it now stands,
 * in queued pages: a block may cover more actors than one request can write.
 * Lifting needs no page to take effect, since readers join the block's
 * current severity; the pages only delete the rows it left. Applying the
 * block again limits every actor it covers again, as each run of Mastodon's
 * `DomainBlockWorker` does (`process_domain_block!` over the accounts
 * `without_silenced` / `without_suspended`): the admin's lifts of it go, and
 * so does a pending backfill, which a full recording supersedes.
 */
export const startDomainBlockLimits = async (env: Env, domainBlockId: string): Promise<void> => {
  const forgotten = await runD1(() => env.DB.batch(forgetBlockState(env.DB, domainBlockId)));
  if (forgotten.isErr()) {
    console.error(JSON.stringify({ kind: "DomainBlockLiftsNotForgotten", domainBlockId }));
  }
  await startJob(env, recordJob(domainBlockId), processRecordDomainBlockLimitsJob, "Queued");
};

/** Distinct blocks with rows one hourly sweep looks at. */
const RESUME_SCAN = 200;

/** Messages one `sendBatch` takes. */
const QUEUE_BATCH = 100;

const BlockIdRow = z.object({ id: z.string() });

/**
 * The blocks with rows left in `remote_actor_domain_limits` that no longer
 * silence or suspend: removed, or made a `noop`. The distinct block ids are
 * walked one index seek each, never the rows themselves.
 */
const listLiftedDomainBlockIds = (db: D1Database): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `WITH RECURSIVE ids(id, n) AS (
           SELECT (SELECT min(domain_block_id) FROM remote_actor_domain_limits), 1
           UNION ALL
           SELECT (SELECT min(domain_block_id) FROM remote_actor_domain_limits WHERE domain_block_id > ids.id), n + 1
           FROM ids WHERE ids.id IS NOT NULL AND n < ?
         )
         SELECT id FROM ids
         WHERE id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM domain_blocks d WHERE d.id = ids.id AND d.severity IN ('silence', 'suspend')
         )`,
      )
      .bind(RESUME_SCAN)
      .all();
    return parseRows(BlockIdRow, results).map((row) => row.id);
  });

const Backfill = z.object({ id: z.string(), seen_by: z.string() });
type Backfill = z.infer<typeof Backfill>;

/**
 * The silences and suspensions made before their actors were recorded
 * (migration 0171), each with the time of its last change.
 */
const listBackfills = (db: D1Database): Promise<Result<Backfill[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare("SELECT domain_block_id AS id, seen_by FROM domain_block_limit_backfills LIMIT ?")
      .bind(RESUME_SCAN)
      .all();
    return parseRows(Backfill, results);
  });

/**
 * Queue the deletion of the rows each lifted block left, for a chain that
 * stopped before it finished: a next page that could not be queued, or a job
 * that gave up its retries (hourly cron). A chain still running gets a
 * second job; both delete what is left. Each block still to be recorded once
 * gets its recording queued the same way, until a chain finishes it.
 */
export const processResumeLiftedDomainBlockLimitsJob = (env: Env) =>
  measureJobPage(env, "ResumeLiftedDomainBlockLimits", async () => {
    const [lifted, backfills] = await Promise.all([
      listLiftedDomainBlockIds(env.DB),
      listBackfills(env.DB),
    ]);
    if (lifted.isErr() || backfills.isErr()) {
      return { outcome: "retry", size: -1, chained: false };
    }
    const jobs = [...lifted.value.map(recordJob), ...backfills.value.map(backfillJob)];
    for (let start = 0; start < jobs.length; start += QUEUE_BATCH) {
      await env.OUTBOX_PROCESS_QUEUE.sendBatch(
        jobs.slice(start, start + QUEUE_BATCH).map((body) => ({ body })),
      );
    }
    return { outcome: "ok", size: jobs.length, chained: jobs.length > 0 };
  });

const ActorUriRow = z.object({ actor_uri: z.string() });

/** The actors among `actorUris` that a suspension suspended when it was made, unless an admin lifted it. */
export const listDomainSuspendedActors = async (
  db: D1Database,
  actorUris: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  if (actorUris.length === 0) {
    return ok(new Set());
  }
  return runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT l.actor_uri FROM remote_actor_domain_limits l
         JOIN domain_blocks d ON d.id = l.domain_block_id
         WHERE d.severity = 'suspend' AND l.actor_uri IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (
             SELECT 1 FROM remote_actor_domain_lifts x
             WHERE x.domain_block_id = l.domain_block_id AND x.actor_uri = l.actor_uri
               AND x.severity = 'suspend'
           )`,
      )
      .bind(jsonStringArray([...new Set(actorUris)]))
      .all();
    return new Set(parseRows(ActorUriRow, results).map((row) => row.actor_uri));
  });
};

/** The severity of a domain block one actor's lift undoes. */
export type LiftedSeverity = "silence" | "suspend";

/**
 * Lift the `severity` each instance domain block holds on the actor now, as
 * Mastodon's per-account `unsilence!` / `unsuspend!` clear the
 * `silenced_at` / `suspended_at` that `BlockDomainService` set, until the
 * block is applied again ({@link startDomainBlockLimits}).
 */
export const liftDomainBlockLimits = (
  db: D1Database,
  actorUri: string,
  severity: LiftedSeverity,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT OR REPLACE INTO remote_actor_domain_lifts (domain_block_id, actor_uri, severity)
         SELECT DISTINCT domain_block_id, actor_uri, severity FROM remote_actor_domain_rules
         WHERE actor_uri = ? AND severity = ?`,
      )
      .bind(actorUri, severity)
      .run();
  });

const StandingRow = z.object({ actor_uri: z.string(), rank: z.number() });

const STANDING_OF_RANK: ReadonlyArray<AccountStanding> = [
  AccountStanding.inGoodStanding,
  { kind: "Silenced" },
  { kind: "Suspended" },
];

/**
 * The standing the instance domain blocks hold on each of `actorUris`, the
 * stronger when more than one does, as Mastodon's `silenced_at` /
 * `suspended_at` set by `BlockDomainService` or at the account's creation
 * (`ProcessAccountService#create_account`). Actors no block limits are absent.
 */
export const listDomainBlockStandings = async (
  db: D1Database,
  actorUris: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, AccountStanding>, RepositoryError>> => {
  if (actorUris.length === 0) {
    return ok(new Map());
  }
  return runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT actor_uri,
                max(CASE severity WHEN 'suspend' THEN 2 WHEN 'silence' THEN 1 ELSE 0 END) AS rank
         FROM remote_actor_domain_rules
         WHERE actor_uri IN (SELECT value FROM json_each(?))
         GROUP BY actor_uri HAVING rank > 0`,
      )
      .bind(jsonStringArray([...new Set(actorUris)]))
      .all();
    return new Map(
      parseRows(StandingRow, results).flatMap((row) => {
        const standing = STANDING_OF_RANK[row.rank];
        return standing === undefined ? [] : [[row.actor_uri, standing] as const];
      }),
    );
  });
};
