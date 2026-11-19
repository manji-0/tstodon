import {
  type OwedStatusActivity,
  OutboxDelivery,
  PendingStatusFederation,
  type PendingStatusFederation as PendingStatusFederationValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { parseRows, type RepositoryError, runD1, runD1Batch } from "./d1";
import { newEntityId } from "./ids";

const PendingRow = z.object({
  status_id: z.string(),
  activity: z.string(),
  revision: z.number(),
  attempts: z.number(),
  next_attempt_at: z.string(),
});

const toPending = (row: z.infer<typeof PendingRow>): PendingStatusFederationValue[] => {
  const parsed = PendingStatusFederation.parse({
    statusId: row.status_id,
    activity: row.activity,
    revision: row.revision,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
  });
  return parsed.isOk() ? [parsed.value] : [];
};

/**
 * Record that the status owes `activity`, first tried and failed now, to be
 * tried again at `nextAttemptAt`. A status that already owes one keeps a
 * `Create` (its edit goes as the `Create` of its current version) and its
 * count of tries, and moves to the new revision.
 */
export const deferStatusFederation = (
  db: D1Database,
  statusId: string,
  activity: OwedStatusActivity,
  nextAttemptAt: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO pending_status_federations
           (status_id, activity, revision, attempts, next_attempt_at, created_at)
         VALUES (?, ?, 0, 1, ?, ?)
         ON CONFLICT (status_id) DO UPDATE SET
           activity = CASE WHEN activity = 'Create' THEN 'Create' ELSE excluded.activity END,
           revision = revision + 1,
           next_attempt_at = excluded.next_attempt_at`,
      )
      .bind(statusId, activity, nextAttemptAt, nowIso())
      .run();
  });

/**
 * Note a change of a status that still owes an activity: a retry that built
 * the previous version stores nothing, and the next one is due now. Resolves
 * to whether the status owes one.
 */
export const reviseStatusFederation = (
  db: D1Database,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const changed = await db
      .prepare(
        `UPDATE pending_status_federations SET revision = revision + 1, next_attempt_at = ?
         WHERE status_id = ?`,
      )
      .bind(nowIso(), statusId)
      .run();
    return changed.meta.changes > 0;
  });

/** The owed activities due by `now`, the longest waiting first. */
export const listDueStatusFederations = async (
  db: D1Database,
  now: string,
  limit: number,
): Promise<Result<PendingStatusFederationValue[], RepositoryError>> =>
  (
    await runD1(() =>
      db
        .prepare(
          `SELECT status_id, activity, revision, attempts, next_attempt_at
           FROM pending_status_federations WHERE next_attempt_at <= ?
           ORDER BY next_attempt_at LIMIT ?`,
        )
        .bind(now, limit)
        .all(),
    )
  ).map((rows) => parseRows(PendingRow, rows.results).flatMap(toPending));

/** Whether any owed activity is due by `now`. */
export const hasDueStatusFederation = async (
  db: D1Database,
  now: string,
): Promise<Result<boolean, RepositoryError>> =>
  (await listDueStatusFederations(db, now, 1)).map((rows) => rows.length > 0);

/** Count a failed try of `pending` and set its next one, unless the status changed meanwhile. */
export const postponeStatusFederation = (
  db: D1Database,
  pending: PendingStatusFederationValue,
  attempts: number,
  nextAttemptAt: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `UPDATE pending_status_federations SET attempts = ?, next_attempt_at = ?
         WHERE status_id = ? AND revision = ?`,
      )
      .bind(attempts, nextAttemptAt, pending.statusId, pending.revision)
      .run();
  });

/** Forget the activity a status owes: it is given up, or the status cannot send it. */
export const dropStatusFederation = (
  db: D1Database,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare("DELETE FROM pending_status_federations WHERE status_id = ?")
      .bind(statusId)
      .run();
  });

/**
 * Store the owed activity, signed by `accountId` with its fan-out to the
 * followers `Queued`, and forget that it is owed, in one batch, but only
 * while the status still owes it at `pending`'s revision: a status deleted
 * or changed meanwhile stores nothing, and of two retries of the same
 * revision only one stores it. Resolves to the stored activity's id, or
 * `undefined` when nothing was stored.
 */
export const storeOwedActivity = async (
  db: D1Database,
  pending: PendingStatusFederationValue,
  accountId: string,
  payload: unknown,
): Promise<Result<string | undefined, RepositoryError>> => {
  const id = newEntityId();
  const createdAt = nowIso();
  const fanout = OutboxDelivery.queued();
  const batched = await runD1Batch(db, [
    db
      .prepare(
        `INSERT INTO outbound_activities (id, account_id, kind, payload_json, created_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM pending_status_federations WHERE status_id = ? AND revision = ?
         )`,
      )
      .bind(
        id,
        accountId,
        pending.activity,
        JSON.stringify(payload),
        createdAt,
        pending.statusId,
        pending.revision,
      ),
    db
      .prepare(
        `INSERT INTO outbox_deliveries (id, activity_id, kind, attempt_count, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM outbound_activities WHERE id = ?)`,
      )
      .bind(newEntityId(), id, fanout.kind, fanout.attemptCount, createdAt, createdAt, id),
    db
      .prepare("DELETE FROM pending_status_federations WHERE status_id = ? AND revision = ?")
      .bind(pending.statusId, pending.revision),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok((batched.value[0]?.meta.changes ?? 0) > 0 ? id : undefined);
};
