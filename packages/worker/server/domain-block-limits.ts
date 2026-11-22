import { Hostname, type OutboxJob } from "@tstodon/domain";
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

/** Rows one page records or deletes. */
const PAGE = 500;

/** Record the next page of actors at or under `domain` the block has not recorded yet. */
const recordPage = (
  db: D1Database,
  blockId: string,
  domain: Hostname,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const { from, to } = hostKeyRange(domain);
    const written = await db
      .prepare(
        `INSERT OR IGNORE INTO remote_actor_domain_limits (domain_block_id, actor_uri)
         SELECT ?1, r.actor_uri FROM remote_actors r
         WHERE ((r.host_key >= ?2 AND r.host_key < ?3) OR (r.uri_host_key >= ?2 AND r.uri_host_key < ?3))
           AND NOT EXISTS (
             SELECT 1 FROM remote_actor_domain_limits l
             WHERE l.domain_block_id = ?1 AND l.actor_uri = r.actor_uri
           )
         LIMIT ?4`,
      )
      .bind(blockId, from, to, PAGE)
      .run();
    return written.meta.changes;
  });

/** Delete the next page of rows a lifted block left. */
const forgetPage = (db: D1Database, blockId: string): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const deleted = await db
      .prepare(
        `DELETE FROM remote_actor_domain_limits WHERE rowid IN (
           SELECT rowid FROM remote_actor_domain_limits WHERE domain_block_id = ? LIMIT ?
         )`,
      )
      .bind(blockId, PAGE)
      .run();
    return deleted.meta.changes;
  });

/**
 * Run one page of {@link startDomainBlockLimits}: record while the block
 * silences or suspends, delete once it is a `noop` or gone. A full page
 * queues the job again; each page finds only what is left, so a retry or a
 * second job for the same block converges.
 */
export const processRecordDomainBlockLimitsJob = (env: Env, job: RecordJob) =>
  measureJobPage(env, job.kind, async () => {
    const found = await findDomainBlockById(env.DB, job.domainBlockId);
    if (found.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    const block = found.value;
    const lifted = block === undefined || block.severity === "noop";
    const page = lifted
      ? await forgetPage(env.DB, job.domainBlockId)
      : await recordPage(env.DB, block.id, Hostname.ofAuthority(block.domain));
    if (page.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    const chained = page.value === PAGE;
    if (chained) {
      await env.OUTBOX_PROCESS_QUEUE.send(job);
    }
    return {
      outcome: "ok",
      size: page.value,
      chained,
      step: lifted ? "Forget" : "Record",
    };
  });

/**
 * Bring the actors a block limits in line with the block as it now stands,
 * in queued pages: a block may cover more actors than one request can write.
 * Lifting needs no page to take effect, since readers join the block's
 * current severity; the pages only delete the rows it left.
 */
export const startDomainBlockLimits = (env: Env, domainBlockId: string): Promise<void> =>
  startJob(
    env,
    { kind: "RecordDomainBlockLimits", domainBlockId },
    processRecordDomainBlockLimitsJob,
    "Queued",
  );

const ActorUriRow = z.object({ actor_uri: z.string() });

/** The actors among `actorUris` that a suspension suspended when it was made. */
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
         WHERE d.severity = 'suspend' AND l.actor_uri IN (SELECT value FROM json_each(?))`,
      )
      .bind(jsonStringArray([...new Set(actorUris)]))
      .all();
    return new Set(parseRows(ActorUriRow, results).map((row) => row.actor_uri));
  });
};
