import { assertNever, Sensitive, type SensitiveValue, warmSchemas } from "@tstodon/core";
import {
  ActivityId,
  OutboxDelivery,
  type OutboxDelivery as OutboxDeliveryValue,
  type StuckDeliveryTarget,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { parseRows, type RepositoryError, runD1, runD1Batch } from "./d1";
import { newEntityId } from "./ids";
import { toRepositoryError } from "./d1";
import {
  d1PrepareTyped,
  queryTyped,
  runTyped,
  runTypedBatch,
  runTypedBatchChunked,
  type TypedSqlLike,
} from "./typed-sql";
import {
  findOutboundActivity as findOutboundActivitySql,
  findOutboundActivityWithSigner as findOutboundActivityWithSignerSql,
  findNextOutboxTargetDue as findNextOutboxTargetDueSql,
  findOutboxFanout as findOutboxFanoutSql,
  findOutboxTarget as findOutboxTargetSql,
  insertOutboundActivity as insertOutboundActivitySql,
  insertOutboundDepartedSigner as insertOutboundDepartedSignerSql,
  insertOutboxDeliveryFanout as insertOutboxDeliveryFanoutSql,
  insertOutboxTargetOrIgnore as insertOutboxTargetOrIgnoreSql,
  insertOutboxTargets as insertOutboxTargetsSql,
  insertSettledOutboxTargetOrIgnore as insertSettledOutboxTargetOrIgnoreSql,
  listDueOutboxTargets as listDueOutboxTargetsSql,
  listStuckOutboxTargets as listStuckOutboxTargetsSql,
  postponeOutboxTarget as postponeOutboxTargetSql,
  listOutboundActivities as listOutboundActivitiesSql,
  updateOutboxFanout as updateOutboxFanoutSql,
  updateOutboxTarget as updateOutboxTargetSql,
} from "./generated/prisma/sql";

export const OutboundActivityRowSchema = z.object({
  id: z.string().min(1),
  /** `null` for an activity the instance actor signs. */
  account_id: z.string().min(1).nullable(),
  kind: z.string().min(1),
  payload_json: z.string().min(1),
  created_at: z.string().min(1),
});

export const OutboxDeliveryRowSchema = z.object({
  kind: z.string().min(1),
  reason_kind: z.string().nullable(),
  attempt_count: z.number(),
  http_status: z.number().nullable(),
  inbox_url: z.string().nullable(),
});

export type OutboundActivityRow = z.infer<typeof OutboundActivityRowSchema>;

const OutboundActivityWithSignerRowSchema = OutboundActivityRowSchema.extend({
  /**
   * The signing account's, or the ones kept for a deleted account's last
   * activity. `null` for the instance actor, or when the signing account is gone.
   */
  signer_username: z.string().nullable(),
  signer_private_key_jwk: Sensitive.schema(z.string().min(1)).nullable(),
  /** 1 when each POST carries a `Collection-Synchronization` header. */
  synchronize_followers: z.number(),
  /** When the signing account's key pair was last replaced, if ever. */
  signer_key_rotated_at: z.string().nullable(),
});

export type OutboundActivityWithSignerRow = z.infer<typeof OutboundActivityWithSignerRowSchema>;

const persistColumns = (
  delivery: OutboxDeliveryValue,
): {
  kind: string;
  reasonKind: string | null;
  attemptCount: number;
  httpStatus: number | null;
} => {
  switch (delivery.kind) {
    case "Queued":
      return {
        kind: delivery.kind,
        reasonKind: null,
        attemptCount: delivery.attemptCount,
        httpStatus: null,
      };
    case "Expanded":
    case "Delivered":
      return {
        kind: delivery.kind,
        reasonKind: null,
        attemptCount: 0,
        httpStatus: null,
      };
    case "Skipped":
      return {
        kind: delivery.kind,
        reasonKind: delivery.reasonKind,
        attemptCount: 0,
        httpStatus: null,
      };
    case "Failed":
      switch (delivery.reasonKind) {
        case "RetryExhausted":
          return {
            kind: delivery.kind,
            reasonKind: delivery.reasonKind,
            attemptCount: delivery.attemptCount,
            httpStatus: null,
          };
        case "Permanent":
          return {
            kind: delivery.kind,
            reasonKind: delivery.reasonKind,
            attemptCount: 0,
            httpStatus: delivery.httpStatus,
          };
        default:
          return assertNever(delivery);
      }
    default:
      return assertNever(delivery);
  }
};

const outboxDeliveryFromRow = (
  row: z.infer<typeof OutboxDeliveryRowSchema>,
): Result<OutboxDeliveryValue, RepositoryError> => {
  if (row.kind === "Skipped") {
    return OutboxDelivery.parse({ kind: "Skipped", reasonKind: row.reason_kind }).mapErr(() =>
      toRepositoryError("invalid outbox delivery row"),
    );
  }
  if (row.kind === "Failed" && row.reason_kind === "Permanent") {
    return OutboxDelivery.parse({
      kind: "Failed",
      reasonKind: "Permanent",
      httpStatus: row.http_status,
    }).mapErr(() => toRepositoryError("invalid outbox delivery row"));
  }
  if (row.kind === "Failed") {
    return OutboxDelivery.parse({
      kind: "Failed",
      reasonKind: "RetryExhausted",
      attemptCount: row.attempt_count,
    }).mapErr(() => toRepositoryError("invalid outbox delivery row"));
  }
  if (row.kind === "Queued") {
    return OutboxDelivery.parse({
      kind: "Queued",
      attemptCount: row.attempt_count,
    }).mapErr(() => toRepositoryError("invalid outbox delivery row"));
  }
  return OutboxDelivery.parse({ kind: row.kind }).mapErr(() =>
    toRepositoryError("invalid outbox delivery row"),
  );
};

/** Who signs an outbound activity: a local account, or the instance actor. */
export type OutboundSigner =
  | Readonly<{ kind: "Account"; accountId: string }>
  | Readonly<{ kind: "InstanceActor" }>;

/**
 * Where an outbound activity goes. `Followers`: the `ExpandFollowers` job
 * lists the inboxes, and the fan-out row waits `Queued` for it. `Inboxes`:
 * the caller stores the targets itself, so the fan-out row is settled from
 * the start; left `Queued` it would keep the activity from ever being pruned.
 */
export type OutboundAudience = "Followers" | "Inboxes";

export const insertOutboundActivity = async (
  db: D1Database,
  input: {
    signer: OutboundSigner;
    kind: string;
    payload: unknown;
    audience: OutboundAudience;
    /** Each POST carries a `Collection-Synchronization` header (FEP-8fcf). */
    synchronizeFollowers?: boolean;
  },
): Promise<Result<OutboundActivityRow, RepositoryError>> => {
  const accountId = input.signer.kind === "Account" ? input.signer.accountId : null;
  const id = newEntityId();
  const createdAt = nowIso();
  const payloadJson = JSON.stringify(input.payload);
  const fanout = persistColumns(
    input.audience === "Followers" ? OutboxDelivery.queued() : { kind: "Expanded" },
  );
  const batched = await runD1Batch(db, [
    d1PrepareTyped(
      db,
      insertOutboundActivitySql(
        id,
        accountId,
        input.kind,
        payloadJson,
        createdAt,
        input.synchronizeFollowers ? 1 : 0,
      ),
    ),
    d1PrepareTyped(
      db,
      insertOutboxDeliveryFanoutSql(
        newEntityId(),
        id,
        fanout.kind,
        fanout.attemptCount,
        createdAt,
        createdAt,
      ),
    ),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok({
    id,
    account_id: accountId,
    kind: input.kind,
    payload_json: payloadJson,
    created_at: createdAt,
  });
};

const ForwardRow = z.object({ id: z.string(), fanout: z.string().nullable() });

/**
 * Store an inbound activity that `accountId` forwards (`payloadJson`, as
 * received), keyed by the inbound activity's id `forwardOf`, with its
 * fan-out row `Queued` for an `ExpandForward` job. A retried delivery finds
 * the row already there and stores nothing. Answers the stored forward's id
 * while its fan-out is still `Queued` (its expansion may never have been
 * queued), and `undefined` once it was expanded.
 */
export const insertForwardedActivity = async (
  db: D1Database,
  input: Readonly<{ accountId: string; kind: string; payloadJson: string; forwardOf: string }>,
): Promise<Result<string | undefined, RepositoryError>> => {
  const id = newEntityId();
  const createdAt = nowIso();
  const fanout = persistColumns(OutboxDelivery.queued());
  const batched = await runD1Batch(db, [
    db
      .prepare(
        `INSERT OR IGNORE INTO outbound_activities
           (id, account_id, kind, payload_json, created_at, forward_of)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.accountId, input.kind, input.payloadJson, createdAt, input.forwardOf),
    db
      .prepare(
        `INSERT INTO outbox_deliveries (id, activity_id, kind, attempt_count, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM outbound_activities WHERE id = ?)`,
      )
      .bind(newEntityId(), id, fanout.kind, fanout.attemptCount, createdAt, createdAt, id),
    db
      .prepare(
        `SELECT a.id, d.kind AS fanout FROM outbound_activities a
         LEFT JOIN outbox_deliveries d ON d.activity_id = a.id AND d.inbox_url IS NULL
         WHERE a.forward_of = ?`,
      )
      .bind(input.forwardOf),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const [stored] = parseRows(ForwardRow, batched.value[2]?.results ?? []);
  return ok(stored?.fanout === "Queued" ? stored.id : undefined);
};

/** The last activity of a local account that is being deleted, and where it goes. */
export type DepartedAccountActivity = Readonly<{
  id: string;
  username: string;
  privateKeyJwk: SensitiveValue<string>;
  kind: string;
  payload: unknown;
  /** The inboxes to deliver to. */
  deliver: ReadonlyArray<string>;
  /** The inboxes of unavailable domains, stored `Skipped`. */
  skipped: ReadonlyArray<string>;
}>;

/**
 * The statements that store a deleted account's last activity, for the
 * batch that deletes the account: the activity with no account, its targets,
 * and, while a target is to be delivered, the account's name and key that
 * sign it (`outbound_departed_signers`, dropped when the last target leaves
 * `Queued`). One batch, so the activity is stored if and only if the account
 * is deleted. The targets go in one statement however many there are.
 */
export const departedAccountActivityStatements = (
  activity: DepartedAccountActivity,
): TypedSqlLike[] => {
  const createdAt = nowIso();
  const expanded = persistColumns({ kind: "Expanded" });
  const queued = persistColumns(OutboxDelivery.queued());
  const skipped = persistColumns(OutboxDelivery.skipped());
  const targets = [
    ...activity.deliver.map((inboxUrl) => [newEntityId(), inboxUrl, queued.kind, null]),
    ...activity.skipped.map((inboxUrl) => [
      newEntityId(),
      inboxUrl,
      skipped.kind,
      skipped.reasonKind,
    ]),
  ];
  return [
    insertOutboundActivitySql(
      activity.id,
      null,
      activity.kind,
      JSON.stringify(activity.payload),
      createdAt,
      0,
    ),
    insertOutboxDeliveryFanoutSql(
      newEntityId(),
      activity.id,
      expanded.kind,
      expanded.attemptCount,
      createdAt,
      createdAt,
    ),
    insertOutboxTargetsSql(activity.id, JSON.stringify(targets), createdAt),
    ...(activity.deliver.length > 0
      ? [
          insertOutboundDepartedSignerSql(
            activity.id,
            activity.username,
            activity.privateKeyJwk.reveal(),
          ),
        ]
      : []),
  ];
};

export const findOutboundActivity = async (
  db: D1Database,
  id: string,
): Promise<Result<OutboundActivityRow | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findOutboundActivitySql(id), OutboundActivityRowSchema);
  });
  return queried.map((rows) => rows[0]);
};

/** An outbound activity with its signing account's username and private key, in one read. */
export const findOutboundActivityWithSigner = async (
  db: D1Database,
  id: string,
): Promise<Result<OutboundActivityWithSignerRow | undefined, RepositoryError>> => {
  const queried = await runD1(async () =>
    queryTyped(db, findOutboundActivityWithSignerSql(id), OutboundActivityWithSignerRowSchema),
  );
  return queried.map((rows) => rows[0]);
};

/**
 * Store `payloadJson` as the activity's body, unless the body is no longer
 * `previousJson`: a delivery that signed it again concurrently stored its own.
 */
export const replaceOutboundPayload = async (
  db: D1Database,
  id: string,
  previousJson: string,
  payloadJson: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare("UPDATE outbound_activities SET payload_json = ? WHERE id = ? AND payload_json = ?")
      .bind(payloadJson, id, previousJson)
      .run();
  });

export const listOutboundActivities = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<OutboundActivityRow[], RepositoryError>> =>
  runD1(async () => {
    return queryTyped(db, listOutboundActivitiesSql(accountId, limit), OutboundActivityRowSchema);
  });

export const markOutboundExpanded = async (
  db: D1Database,
  activityId: string,
  followerTargetCount: number,
): Promise<Result<void, RepositoryError>> => {
  const parsed = ActivityId.parse(activityId);
  if (parsed.isErr()) {
    return err(toRepositoryError("invalid activity id"));
  }
  return runD1(async () => {
    const next = OutboxDelivery.afterExpand(followerTargetCount);
    const columns = persistColumns(next);
    await runTyped(
      db,
      updateOutboxFanoutSql(
        columns.kind,
        columns.reasonKind,
        columns.attemptCount,
        columns.httpStatus,
        nowIso(),
        activityId,
      ),
    );
  });
};

/** The target's row, inserted `Queued` when missing: the insert and the read are one batch. */
export const ensureOutboxTarget = async (
  db: D1Database,
  activityId: string,
  inboxUrl: string,
): Promise<Result<OutboxDeliveryValue, RepositoryError>> => {
  if (ActivityId.parse(activityId).isErr()) {
    return err(toRepositoryError("invalid activity id"));
  }
  const queued = OutboxDelivery.queued();
  const createdAt = nowIso();
  const insert =
    inboxUrl.length > 0
      ? [
          insertOutboxTargetOrIgnoreSql(
            newEntityId(),
            activityId,
            queued.kind,
            queued.attemptCount,
            inboxUrl,
            createdAt,
            createdAt,
          ),
        ]
      : [];
  const batched = await runTypedBatch(db, [...insert, findOutboxTargetSql(activityId, inboxUrl)]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const row = parseRows(OutboxDeliveryRowSchema, batched.value.at(-1)?.results)[0];
  if (row === undefined) {
    return err(toRepositoryError("outbox target missing after insert"));
  }
  return outboxDeliveryFromRow(row);
};

/** Insert many outbox delivery targets in chunked D1 batches (INSERT OR IGNORE). */
export const ensureOutboxTargets = async (
  db: D1Database,
  activityId: string,
  inboxUrls: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const parsed = ActivityId.parse(activityId);
  if (parsed.isErr()) {
    return err(toRepositoryError("invalid activity id"));
  }
  const unique = [...new Set(inboxUrls.filter((url) => url.length > 0))];
  if (unique.length === 0) {
    return ok(undefined);
  }
  const queued = OutboxDelivery.queued();
  const createdAt = nowIso();
  const statements = unique.map((inboxUrl) =>
    insertOutboxTargetOrIgnoreSql(
      newEntityId(),
      activityId,
      queued.kind,
      queued.attemptCount,
      inboxUrl,
      createdAt,
      createdAt,
    ),
  );
  const batched = await runTypedBatchChunked(db, statements);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

export const findOutboxTarget = async (
  db: D1Database,
  activityId: string,
  inboxUrl: string,
): Promise<Result<OutboxDeliveryValue | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findOutboxTargetSql(activityId, inboxUrl), OutboxDeliveryRowSchema);
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const row = queried.value[0];
  return row === undefined ? ok(undefined) : outboxDeliveryFromRow(row);
};

export const findOutboxFanout = async (
  db: D1Database,
  activityId: string,
): Promise<Result<OutboxDeliveryValue | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findOutboxFanoutSql(activityId), OutboxDeliveryRowSchema);
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const row = queried.value[0];
  return row === undefined ? ok(undefined) : outboxDeliveryFromRow(row);
};

/**
 * Settle or advance a `Queued` target. `nextAttemptAt` is when a target left
 * `Queued` is due again (the stuck-delivery sweep reads it). `lastHttpStatus`
 * is the status of the failed attempt that left it `Queued` or
 * `RetryExhausted`, stored in `http_status` (a `Permanent` failure stores its
 * own; every other state stores none).
 */
export const persistOutboxTarget = async (
  db: D1Database,
  activityId: string,
  inboxUrl: string,
  delivery: OutboxDeliveryValue,
  nextAttemptAt: string | null = null,
  lastHttpStatus: number | null = null,
): Promise<Result<void, RepositoryError>> =>
  persistOutboxTargets(db, activityId, [{ inboxUrl, delivery, nextAttemptAt, lastHttpStatus }]);

/** A `Queued` target's state after one attempt. */
export type SettledOutboxTarget = Readonly<{
  inboxUrl: string;
  delivery: OutboxDeliveryValue;
  nextAttemptAt: string | null;
  lastHttpStatus: number | null;
}>;

/**
 * {@link persistOutboxTarget} for several targets of one activity, in one D1
 * batch. A deleted account's key goes when the last of its activity's targets
 * leaves `Queued` (the `outbound_departed_signers_leave_when_settled` trigger).
 */
export const persistOutboxTargets = async (
  db: D1Database,
  activityId: string,
  settled: ReadonlyArray<SettledOutboxTarget>,
): Promise<Result<void, RepositoryError>> => {
  if (ActivityId.parse(activityId).isErr()) {
    return err(toRepositoryError("invalid activity id"));
  }
  if (settled.length === 0) {
    return ok(undefined);
  }
  const updatedAt = nowIso();
  const batched = await runTypedBatch(
    db,
    settled.map(({ inboxUrl, delivery, nextAttemptAt, lastHttpStatus }) => {
      const columns = persistColumns(delivery);
      const transient =
        delivery.kind === "Queued" ||
        (delivery.kind === "Failed" && delivery.reasonKind === "RetryExhausted");
      return updateOutboxTargetSql(
        columns.kind,
        columns.reasonKind,
        columns.attemptCount,
        columns.httpStatus ?? (transient ? lastHttpStatus : null),
        updatedAt,
        activityId,
        inboxUrl,
        delivery.kind === "Queued" ? nextAttemptAt : null,
      );
    }),
  );
  return batched.map(() => undefined);
};

const DueTargetRowSchema = z.object({
  inbox_url: z.string().min(1),
  attempt_count: z.number().int().nonnegative(),
});

/** A `Queued` target due for an attempt. */
export type DueOutboxTarget = Readonly<{ inboxUrl: string; attemptCount: number }>;

/**
 * Up to `limit` of the activity's `Queued` targets (only `inboxUrl`'s when
 * given) after `afterInboxUrl` in inbox order, due by `dueBy`; a target
 * never attempted is always due.
 */
export const listDueOutboxTargets = async (
  db: D1Database,
  activityId: string,
  inboxUrl: string | null,
  afterInboxUrl: string,
  dueBy: string,
  limit: number,
): Promise<Result<DueOutboxTarget[], RepositoryError>> => {
  const rows = await runD1(() =>
    queryTyped(
      db,
      listDueOutboxTargetsSql(activityId, inboxUrl, afterInboxUrl, dueBy, limit),
      DueTargetRowSchema,
    ),
  );
  return rows.map((found) =>
    found.map((row) => ({ inboxUrl: row.inbox_url, attemptCount: row.attempt_count })),
  );
};

export type NextOutboxTargetDue =
  | Readonly<{ kind: "None" }>
  | Readonly<{ kind: "Now" }>
  | Readonly<{ kind: "At"; at: string }>;

const NextDueRowSchema = z.object({ next_attempt_at: z.string().min(1).nullable() });

/**
 * When the activity's next `Queued` target (only `inboxUrl`'s when given) is
 * due: `"Now"` for one never attempted, `"None"` when no target is `Queued`.
 */
export const findNextOutboxTargetDue = async (
  db: D1Database,
  activityId: string,
  inboxUrl: string | null,
): Promise<Result<NextOutboxTargetDue, RepositoryError>> => {
  const rows = await runD1(() =>
    queryTyped(db, findNextOutboxTargetDueSql(activityId, inboxUrl), NextDueRowSchema),
  );
  return rows.map((found) => {
    const row = found[0];
    if (row === undefined) {
      return { kind: "None" as const };
    }
    return row.next_attempt_at === null
      ? { kind: "Now" as const }
      : { kind: "At" as const, at: row.next_attempt_at };
  });
};

/**
 * Insert targets that are settled without an attempt (`Skipped`), in chunked
 * batches (INSERT OR IGNORE: a target already there keeps its state).
 */
export const insertSkippedOutboxTargets = async (
  db: D1Database,
  activityId: string,
  inboxUrls: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const unique = [...new Set(inboxUrls.filter((url) => url.length > 0))];
  if (unique.length === 0) {
    return ok(undefined);
  }
  const skipped = OutboxDelivery.skipped();
  const columns = persistColumns(skipped);
  const createdAt = nowIso();
  const batched = await runTypedBatchChunked(
    db,
    unique.map((inboxUrl) =>
      insertSettledOutboxTargetOrIgnoreSql(
        newEntityId(),
        activityId,
        columns.kind,
        columns.reasonKind ?? "",
        inboxUrl,
        createdAt,
        createdAt,
      ),
    ),
  );
  return batched.map(() => undefined);
};

const StuckTargetRowSchema = z.object({
  activity_id: z.string().min(1),
  inbox_url: z.string().min(1),
  attempt_count: z.number(),
  created_at: z.string().min(1),
});

/** `Queued` targets whose next attempt was due before `dueBefore`, oldest first. */
export const listStuckOutboxTargets = async (
  db: D1Database,
  dueBefore: string,
  limit: number,
): Promise<Result<StuckDeliveryTarget[], RepositoryError>> => {
  const rows = await runD1(() =>
    queryTyped(db, listStuckOutboxTargetsSql(dueBefore, limit), StuckTargetRowSchema),
  );
  return rows.map((found) =>
    found.map((row) => ({
      activityId: row.activity_id,
      inboxUrl: row.inbox_url,
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
    })),
  );
};

/** Move a `Queued` target's next attempt to `nextAttemptAt`. */
export const postponeOutboxTarget = async (
  db: D1Database,
  activityId: string,
  inboxUrl: string,
  nextAttemptAt: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, postponeOutboxTargetSql(nextAttemptAt, activityId, inboxUrl));
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([
  OutboundActivityRowSchema,
  OutboundActivityWithSignerRowSchema,
  OutboxDeliveryRowSchema,
  StuckTargetRowSchema,
  DueTargetRowSchema,
  NextDueRowSchema,
]);
