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
  edited_at: z.string().nullable(),
  attempts: z.number(),
  next_attempt_at: z.string(),
});

const toPending = (row: z.infer<typeof PendingRow>): PendingStatusFederationValue[] => {
  const parsed = PendingStatusFederation.parse({
    statusId: row.status_id,
    activity: row.activity,
    revision: row.revision,
    ...(row.edited_at === null ? {} : { editedAt: row.edited_at }),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
  });
  return parsed.isOk() ? [parsed.value] : [];
};

/**
 * Record that the status owes `activity`, first tried and failed now, to be
 * tried again at `nextAttemptAt`; `editedAt` is when the change that owes an
 * `Update` was made. A status that already owes one keeps a `Create` (its
 * edit goes as the `Create` of its current version) and its count of tries,
 * and moves to the new revision.
 */
export const deferStatusFederation = (
  db: D1Database,
  statusId: string,
  activity: OwedStatusActivity,
  editedAt: string | undefined,
  nextAttemptAt: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO pending_status_federations
           (status_id, activity, revision, edited_at, attempts, next_attempt_at, created_at)
         VALUES (?, ?, 0, ?, 1, ?, ?)
         ON CONFLICT (status_id) DO UPDATE SET
           activity = CASE WHEN activity = 'Create' THEN 'Create' ELSE excluded.activity END,
           revision = revision + 1,
           edited_at = COALESCE(excluded.edited_at, edited_at),
           next_attempt_at = excluded.next_attempt_at`,
      )
      .bind(statusId, activity, editedAt ?? null, nextAttemptAt, nowIso())
      .run();
  });

/**
 * Note a change of a status while it still owes an activity: a retry that
 * built the previous version stores nothing, and the next one is due now.
 * `editedAt` is when an edit was made; a change that is no edit (a poll's
 * counts) keeps the stored time. Resolves to whether the status owes one.
 */
export const reviseStatusFederation = (
  db: D1Database,
  statusId: string,
  editedAt: string | undefined,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const changed = await db
      .prepare(
        `UPDATE pending_status_federations
         SET revision = revision + 1, edited_at = COALESCE(?, edited_at), next_attempt_at = ?
         WHERE status_id = ?`,
      )
      .bind(editedAt ?? null, nowIso(), statusId)
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
          `SELECT status_id, activity, revision, edited_at, attempts, next_attempt_at
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

/**
 * Forget the activity a status owes, unless the status changed since
 * `pending` was read: it is given up, or the status cannot send it.
 */
export const dropStatusFederation = (
  db: D1Database,
  pending: PendingStatusFederationValue,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare("DELETE FROM pending_status_federations WHERE status_id = ? AND revision = ?")
      .bind(pending.statusId, pending.revision)
      .run();
  });

/** A `QuoteRequest` that goes out with an owed `Create`, and its inboxes. */
export type OwedQuoteRequest = Readonly<{
  payload: unknown;
  deliver: ReadonlyArray<string>;
  /** The inboxes of unavailable domains, stored `Skipped`. */
  skipped: ReadonlyArray<string>;
}>;

/** The ids of the activities {@link storeOwedActivity} stored. */
export type StoredOwedActivity = Readonly<{ activityId: string; quoteRequestId?: string }>;

/**
 * Store the owed activity, signed by `accountId` with its fan-out to the
 * followers `Queued`, and the `QuoteRequest` that goes with it with its
 * targets, and forget that it is owed, in one batch, but only while the
 * status still owes it at `pending`'s revision: a status deleted or changed
 * meanwhile stores nothing, and of two retries of the same revision only one
 * stores it. Resolves to the stored activities' ids, or `undefined` when
 * nothing was stored.
 */
export const storeOwedActivity = async (
  db: D1Database,
  pending: PendingStatusFederationValue,
  accountId: string,
  payload: unknown,
  quoteRequest: OwedQuoteRequest | undefined,
): Promise<Result<StoredOwedActivity | undefined, RepositoryError>> => {
  const createdAt = nowIso();
  const owes = "SELECT 1 FROM pending_status_federations WHERE status_id = ? AND revision = ?";
  const insertActivity = (id: string, kind: string, body: unknown) =>
    db
      .prepare(
        `INSERT INTO outbound_activities (id, account_id, kind, payload_json, created_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (${owes})`,
      )
      .bind(
        id,
        accountId,
        kind,
        JSON.stringify(body),
        createdAt,
        pending.statusId,
        pending.revision,
      );
  const insertFanout = (id: string, kind: string) =>
    db
      .prepare(
        `INSERT INTO outbox_deliveries (id, activity_id, kind, attempt_count, created_at, updated_at)
         SELECT ?, ?, ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM outbound_activities WHERE id = ?)`,
      )
      .bind(newEntityId(), id, kind, createdAt, createdAt, id);
  const activityId = newEntityId();
  const quoteRequestId = quoteRequest && newEntityId();
  const queued = OutboxDelivery.queued();
  const skipped = OutboxDelivery.skipped();
  const skippedReason = skipped.kind === "Skipped" ? skipped.reasonKind : null;
  const quoteStatements =
    quoteRequest && quoteRequestId
      ? [
          insertActivity(quoteRequestId, "QuoteRequest", quoteRequest.payload),
          insertFanout(quoteRequestId, "Expanded"),
          db
            .prepare(
              `INSERT OR IGNORE INTO outbox_deliveries
                 (id, activity_id, kind, reason_kind, attempt_count, inbox_url, created_at, updated_at)
               SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[2]'),
                 json_extract(value, '$[3]'), 0, json_extract(value, '$[1]'), ?, ?
               FROM json_each(?) WHERE EXISTS (SELECT 1 FROM outbound_activities WHERE id = ?)`,
            )
            .bind(
              quoteRequestId,
              createdAt,
              createdAt,
              JSON.stringify([
                ...quoteRequest.deliver.map((inbox) => [newEntityId(), inbox, queued.kind, null]),
                ...quoteRequest.skipped.map((inbox) => [
                  newEntityId(),
                  inbox,
                  skipped.kind,
                  skippedReason,
                ]),
              ]),
              quoteRequestId,
            ),
        ]
      : [];
  const batched = await runD1Batch(db, [
    insertActivity(activityId, pending.activity, payload),
    insertFanout(activityId, queued.kind),
    ...quoteStatements,
    db
      .prepare("DELETE FROM pending_status_federations WHERE status_id = ? AND revision = ?")
      .bind(pending.statusId, pending.revision),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  if ((batched.value[0]?.meta.changes ?? 0) === 0) {
    return ok(undefined);
  }
  return ok(quoteRequestId === undefined ? { activityId } : { activityId, quoteRequestId });
};
