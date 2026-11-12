import { InstanceIdentity, RetentionWindow } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { runD1, runD1Batch, type RepositoryError } from "./d1";
import {
  advanceBackfillCursor as advanceBackfillCursorSql,
  listRemoteStatusRetentionSlice as listRemoteStatusRetentionSliceSql,
  pruneRemoteStatusRetentionSlice as pruneRemoteStatusRetentionSliceSql,
  pruneUnreferencedRemoteActors as pruneUnreferencedRemoteActorsSql,
  readBackfillCursor as readBackfillCursorSql,
} from "./generated/prisma/sql";
import { firstEntityIdAt } from "./ids";
import { elapsedMs, writeMetric } from "./metrics";
import { optionalEnvString, parseInstanceIdentity } from "./runtime-config";
import { d1PrepareTyped, queryTyped } from "./typed-sql";

/** The `backfill_cursors` row migration 0139 seeds for this job. */
const CURSOR = "remote_status_retention";

/** `REMOTE_STATUS_RETENTION_DAYS` when unset, as cfwdon's public remote purge. */
export const REMOTE_STATUS_RETENTION_DEFAULT_DAYS = 7;

/**
 * Remote statuses one hourly run examines: 24,000 a day. A run reads about
 * this many rows plus one per probe that finds a row, and writes only what
 * it deletes.
 */
export const REMOTE_STATUS_RETENTION_SLICE = 1000;

const CursorRow = z.object({ after_id: z.string() });
const SliceRow = z.object({ id: z.string(), actor_uri: z.string() });

export type RemoteStatusRetentionPass = Readonly<{
  examined: number;
  statuses: number;
  actors: number;
  /** The slice came back short, so the next run starts from the lowest id again. */
  wrapped: boolean;
}>;

/** The rows a `RETURNING` delete returned: D1's `meta.changes` also counts cascaded rows. */
const deletedRows = (result: D1Result | undefined): number => result?.results.length ?? 0;

/**
 * One slice of remote status retention: the next `limit` remote statuses
 * after the stored cursor whose id sorts before the cutoff, of which the
 * ones last written before the cutoff that nothing local needs are deleted
 * (`pruneRemoteStatusRetentionSlice.sql` lists what keeps one), then their
 * authors that nothing refers to any more. A short slice moves the cursor
 * back to the start. Two runs on one slice delete the same rows; only one
 * moves the cursor.
 */
export const pruneStaleRemoteStatuses = async (
  env: Env,
  nowMs: number = Date.now(),
  limit: number = REMOTE_STATUS_RETENTION_SLICE,
): Promise<Result<RemoteStatusRetentionPass | undefined, RepositoryError>> => {
  const window = RetentionWindow.parse(
    optionalEnvString(env, "REMOTE_STATUS_RETENTION_DAYS"),
    REMOTE_STATUS_RETENTION_DEFAULT_DAYS,
    1,
  );
  const cutoff = RetentionWindow.cutoff(window, nowMs);
  const identity = parseInstanceIdentity(env);
  if (cutoff === undefined || identity.isErr()) {
    return ok(undefined);
  }
  const db = env.DB;
  const read = await runD1(async () => {
    const cursor = (await queryTyped(db, readBackfillCursorSql(CURSOR), CursorRow))[0];
    const afterId = cursor?.after_id ?? "";
    const slice = await queryTyped(
      db,
      listRemoteStatusRetentionSliceSql(afterId, firstEntityIdAt(Date.parse(cutoff)), limit),
      SliceRow,
    );
    return { afterId, slice };
  });
  if (read.isErr()) {
    return err(read.error);
  }
  const { afterId, slice } = read.value;
  const last = slice.at(-1);
  const wrapped = slice.length < limit;
  const nextId = wrapped ? "" : (last?.id ?? "");
  const advance =
    nextId === afterId
      ? []
      : [d1PrepareTyped(db, advanceBackfillCursorSql(CURSOR, afterId, nextId, null))];
  const ran = await runD1Batch(
    db,
    last === undefined
      ? advance
      : [
          d1PrepareTyped(
            db,
            pruneRemoteStatusRetentionSliceSql(
              afterId,
              last.id,
              cutoff,
              InstanceIdentity.actorUrl(identity.value, ""),
            ),
          ),
          d1PrepareTyped(
            db,
            pruneUnreferencedRemoteActorsSql(
              JSON.stringify([...new Set(slice.map((row) => row.actor_uri))]),
              cutoff,
            ),
          ),
          ...advance,
        ],
  );
  if (ran.isErr()) {
    return err(ran.error);
  }
  return ok({
    examined: slice.length,
    statuses: last === undefined ? 0 : deletedRows(ran.value[0]),
    actors: last === undefined ? 0 : deletedRows(ran.value[1]),
    wrapped,
  });
};

/**
 * Hourly cron path: one retention slice. Logs `RemoteStatusRetentionPass`
 * and writes the `remote_status.retention` metric; nothing when retention
 * is off.
 */
export const runRemoteStatusRetention = async (env: Env): Promise<void> => {
  const startedAt = Date.now();
  const pass = await pruneStaleRemoteStatuses(env);
  const ms = elapsedMs(startedAt);
  if (pass.isErr()) {
    console.error(
      JSON.stringify({ kind: "RemoteStatusRetentionFailed", message: pass.error.message }),
    );
    writeMetric(env, "remote_status.retention", [0, 0, 0, ms], ["error", ""]);
    return;
  }
  if (pass.value === undefined) {
    return;
  }
  const { examined, statuses, actors, wrapped } = pass.value;
  console.log(
    JSON.stringify({ kind: "RemoteStatusRetentionPass", examined, statuses, actors, wrapped, ms }),
  );
  // doubles: [examined, statuses, actors, ms]; blobs: [ok | error, wrapped | ""]
  writeMetric(
    env,
    "remote_status.retention",
    [examined, statuses, actors, ms],
    ["ok", wrapped ? "wrapped" : ""],
  );
};
