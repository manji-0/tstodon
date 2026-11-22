import { type DomainBlockLimits, Hostname, type OutboxJob } from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import { z } from "zod";
import { findDomainBlockById } from "./admin-domain-block-store";
import { jsonStringArray, parseRows, runD1, type RepositoryError } from "./d1";
import { hostKeyRange } from "./host-key";
import { startJob } from "./inline-job";
import { measureJobPage } from "./metrics";
import { nowIso } from "./clock";
import type { TypedSqlLike } from "./typed-sql";

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

/** Statements that forget what the admin's lifts and a pending backfill kept for a block. */
const forgetBlockState = (db: D1Database, blockId: string): D1PreparedStatement[] => [
  db.prepare("DELETE FROM remote_actor_domain_lifts WHERE domain_block_id = ?").bind(blockId),
  db.prepare("DELETE FROM domain_block_limit_backfills WHERE domain_block_id = ?").bind(blockId),
];

const isStart = (cursor: Cursor): boolean =>
  cursor.host === START.host &&
  cursor.afterKey === START.afterKey &&
  cursor.afterRowId === START.afterRowId;

/**
 * Record the actors of the page after `cursor` under block `blockId`, unless
 * the block no longer silences or suspends by the time the statement runs,
 * so a block changed or removed meanwhile leaves no rows. The first page of
 * an `Apply` run forgets the admin's lifts of the block and a pending
 * backfill in the same batch, so a failure is retried with the page. A
 * `Backfill` run records only the actors first seen by its `seenBy`, and
 * each of its pages stamps the backfill's claim. Resolves to the cursor
 * after the page, `undefined` once both hosts are read.
 */
const recordPage = (
  db: D1Database,
  blockId: string,
  domain: Hostname,
  cursor: Cursor,
  run: RecordJob["run"],
): Promise<Result<Cursor | undefined, RepositoryError>> =>
  runD1(async () => {
    const { from, to } = hostKeyRange(domain);
    const page = recordPageSql(cursor.host);
    const binds = [blockId, from, to, cursor.afterKey, cursor.afterRowId, PAGE];
    const before =
      run.kind === "Apply"
        ? isStart(cursor)
          ? forgetBlockState(db, blockId)
          : []
        : [
            db
              .prepare(
                "UPDATE domain_block_limit_backfills SET claimed_at = ? WHERE domain_block_id = ?",
              )
              .bind(nowIso(), blockId),
          ];
    const results = await db.batch([
      ...before,
      db
        .prepare(
          `INSERT OR IGNORE INTO remote_actor_domain_limits (domain_block_id, actor_uri)
           SELECT ?1, p.actor_uri FROM (${page}) p
           WHERE EXISTS (
             SELECT 1 FROM domain_blocks WHERE id = ?1 AND severity IN ('silence', 'suspend')
           ) AND (?7 IS NULL OR julianday(p.created_at) <= julianday(?7))`,
        )
        .bind(...binds, run.kind === "Backfill" ? run.seenBy : null),
      db.prepare(page).bind(...binds),
    ]);
    const rows = parseRows(PageRow, results.at(-1)?.results);
    const last = rows.at(-1);
    if (last !== undefined && rows.length === PAGE) {
      return { host: cursor.host, afterKey: last.key, afterRowId: last.row_id };
    }
    if (cursor.host === "AccountDomain") {
      return { ...START, host: "UriHost" };
    }
    if (run.kind === "Backfill") {
      await db
        .prepare("DELETE FROM domain_block_limit_backfills WHERE domain_block_id = ?")
        .bind(blockId)
        .run();
    }
    return undefined;
  });

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
      job.run,
    );
    if (next.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    if (next.value !== undefined) {
      await env.OUTBOX_PROCESS_QUEUE.send({ ...job, cursor: next.value });
    }
    return { outcome: "ok", size: -1, chained: next.value !== undefined, step: job.cursor.host };
  });

const applyJob = (domainBlockId: string): RecordJob => ({
  kind: "RecordDomainBlockLimits",
  domainBlockId,
  cursor: START,
  run: { kind: "Apply" },
});

/**
 * Bring the actors a block limits in line with the block as it now stands,
 * in queued pages: a block may cover more actors than one request can write.
 * Lifting needs no page to take effect, since readers join the block's
 * current severity; the pages only delete the rows it left. Applying the
 * block again limits every actor it covers again, as each run of Mastodon's
 * `DomainBlockWorker` does (`process_domain_block!` over the accounts
 * `without_silenced` / `without_suspended`): its first page forgets the
 * admin's lifts of the block, and a pending backfill, which a full recording
 * supersedes.
 */
export const startDomainBlockLimits = (env: Env, domainBlockId: string): Promise<void> =>
  startJob(env, applyJob(domainBlockId), processRecordDomainBlockLimitsJob, "Queued");

/** Distinct blocks with rows, and backfills, one hourly sweep looks at. */
const RESUME_SCAN = 200;

/** Messages one `sendBatch` takes. */
const QUEUE_BATCH = 100;

/** How long a backfill's claim holds without a page stamping it. */
const BACKFILL_CLAIM_HOURS = 1;

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

const ClaimedBackfill = z.object({ id: z.string(), seen_by: z.string() });

/**
 * Claim the silences and suspensions made before their actors were recorded
 * (migration 0171) that no chain records now: unclaimed, or whose claim no
 * page stamped for {@link BACKFILL_CLAIM_HOURS}.
 */
const claimBackfills = (
  db: D1Database,
): Promise<Result<z.infer<typeof ClaimedBackfill>[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `UPDATE domain_block_limit_backfills SET claimed_at = ?1
         WHERE domain_block_id IN (
           SELECT domain_block_id FROM domain_block_limit_backfills
           WHERE claimed_at IS NULL OR julianday(claimed_at) < julianday(?1) - ?2 / 24.0
           LIMIT ?3
         )
         RETURNING domain_block_id AS id, seen_by`,
      )
      .bind(nowIso(), BACKFILL_CLAIM_HOURS, RESUME_SCAN)
      .all();
    return parseRows(ClaimedBackfill, results);
  });

/**
 * Queue the deletion of the rows each lifted block left, for a chain that
 * stopped before it finished: a next page that could not be queued, or a job
 * that gave up its retries (hourly cron). A chain still running gets a
 * second job; both delete what is left. Each backfill no chain holds gets
 * its recording queued, until a chain finishes it.
 */
export const processResumeLiftedDomainBlockLimitsJob = (env: Env) =>
  measureJobPage(env, "ResumeLiftedDomainBlockLimits", async () => {
    const [lifted, backfills] = await Promise.all([
      listLiftedDomainBlockIds(env.DB),
      claimBackfills(env.DB),
    ]);
    if (lifted.isErr() || backfills.isErr()) {
      return { outcome: "retry", size: -1, chained: false };
    }
    const jobs: RecordJob[] = [
      ...lifted.value.map(applyJob),
      ...backfills.value.map((backfill): RecordJob => ({
        ...applyJob(backfill.id),
        run: { kind: "Backfill", seenBy: backfill.seen_by },
      })),
    ];
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

/** The blocks that hold `severity` on the actor now. */
export const listLimitingDomainBlockIds = (
  db: D1Database,
  actorUri: string,
  severity: LiftedSeverity,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT domain_block_id AS id FROM remote_actor_domain_rules
         WHERE actor_uri = ? AND severity = ?`,
      )
      .bind(actorUri, severity)
      .all();
    return parseRows(BlockIdRow, results).map((row) => row.id);
  });

/**
 * The statements that lift `severity` of blocks `blockIds` on the actor, as
 * Mastodon's per-account `unsilence!` / `unsuspend!` clear the
 * `silenced_at` / `suspended_at` that `BlockDomainService` set, until the
 * block is applied again ({@link startDomainBlockLimits}).
 */
export const liftDomainBlockLimitsSql = (
  actorUri: string,
  severity: LiftedSeverity,
  blockIds: ReadonlyArray<string>,
): TypedSqlLike[] =>
  blockIds.map((id) => ({
    sql: `INSERT OR REPLACE INTO remote_actor_domain_lifts (domain_block_id, actor_uri, severity)
          VALUES ($1, $2, $3)`,
    values: [id, actorUri, severity],
  }));

const LimitsRow = z.object({ actor_uri: z.string(), silenced: z.number(), suspended: z.number() });

/**
 * The silence and the suspension the instance domain blocks hold on each of
 * `actorUris`, as Mastodon's `silenced_at` / `suspended_at` that
 * `BlockDomainService` or `ProcessAccountService#create_account` set. Actors
 * no block limits are absent.
 */
export const listDomainBlockLimits = async (
  db: D1Database,
  actorUris: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, DomainBlockLimits>, RepositoryError>> => {
  if (actorUris.length === 0) {
    return ok(new Map());
  }
  return runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT actor_uri, max(severity = 'silence') AS silenced, max(severity = 'suspend') AS suspended
         FROM remote_actor_domain_rules
         WHERE actor_uri IN (SELECT value FROM json_each(?)) AND severity IN ('silence', 'suspend')
         GROUP BY actor_uri`,
      )
      .bind(jsonStringArray([...new Set(actorUris)]))
      .all();
    return new Map(
      parseRows(LimitsRow, results).map(
        (row) =>
          [
            row.actor_uri,
            { silenced: row.silenced !== 0, suspended: row.suspended !== 0 },
          ] as const,
      ),
    );
  });
};
