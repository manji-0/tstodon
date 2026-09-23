import { assertNever } from "@tstodon/core";
import {
  ActivityId,
  OutboxDelivery,
  type OutboxDelivery as OutboxDeliveryValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { nowIso } from "./clock";
import { runD1, runD1Batch, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import {
  parseRow,
  OutboundActivityRowSchema,
  OutboxDeliveryRowSchema,
  toRepositoryError,
} from "./schemas";
import { d1PrepareTyped, queryTyped, runTyped, runTypedBatchChunked } from "./typed-sql";
import {
  findOutboundActivity as findOutboundActivitySql,
  findOutboxFanout as findOutboxFanoutSql,
  findOutboxTarget as findOutboxTargetSql,
  insertOutboundActivity as insertOutboundActivitySql,
  insertOutboxDeliveryFanout as insertOutboxDeliveryFanoutSql,
  insertOutboxTargetOrIgnore as insertOutboxTargetOrIgnoreSql,
  listOutboundActivities as listOutboundActivitiesSql,
  updateOutboxFanout as updateOutboxFanoutSql,
  updateOutboxTarget as updateOutboxTargetSql,
} from "./generated/prisma/sql";

export type OutboundActivityRow = z.infer<typeof OutboundActivityRowSchema>;

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

export const parseOutboxDelivery = (raw: unknown): Result<OutboxDeliveryValue, RepositoryError> => {
  const row = parseRow(OutboxDeliveryRowSchema, raw);
  if (row.isErr()) {
    return err(row.error);
  }
  if (row.value.kind === "Failed" && row.value.reason_kind === "Permanent") {
    return OutboxDelivery.parse({
      kind: "Failed",
      reasonKind: "Permanent",
      httpStatus: row.value.http_status,
    }).mapErr(() => toRepositoryError("invalid outbox delivery row"));
  }
  if (row.value.kind === "Failed") {
    return OutboxDelivery.parse({
      kind: "Failed",
      reasonKind: "RetryExhausted",
      attemptCount: row.value.attempt_count,
    }).mapErr(() => toRepositoryError("invalid outbox delivery row"));
  }
  if (row.value.kind === "Queued") {
    return OutboxDelivery.parse({
      kind: "Queued",
      attemptCount: row.value.attempt_count,
    }).mapErr(() => toRepositoryError("invalid outbox delivery row"));
  }
  return OutboxDelivery.parse({ kind: row.value.kind }).mapErr(() =>
    toRepositoryError("invalid outbox delivery row"),
  );
};

export const insertOutboundActivity = async (
  db: D1Database,
  input: {
    accountId: string;
    kind: string;
    payload: unknown;
  },
): Promise<Result<OutboundActivityRow, RepositoryError>> => {
  const id = newEntityId();
  const createdAt = nowIso();
  const payloadJson = JSON.stringify(input.payload);
  const queued = OutboxDelivery.queued();
  const batched = await runD1Batch(db, [
    d1PrepareTyped(
      db,
      insertOutboundActivitySql(id, input.accountId, input.kind, payloadJson, createdAt),
    ),
    d1PrepareTyped(
      db,
      insertOutboxDeliveryFanoutSql(
        newEntityId(),
        id,
        queued.kind,
        queued.attemptCount,
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
    account_id: input.accountId,
    kind: input.kind,
    payload_json: payloadJson,
    created_at: createdAt,
  });
};

export const findOutboundActivity = async (
  db: D1Database,
  id: string,
): Promise<Result<OutboundActivityRow | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findOutboundActivitySql(id));
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const raw = queried.value[0];
  if (!raw) {
    return ok(undefined);
  }
  const row = parseRow(OutboundActivityRowSchema, raw);
  if (row.isErr()) {
    return err(toRepositoryError("invalid outbound activity row"));
  }
  return ok(row.value);
};

export const listOutboundActivities = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<OutboundActivityRow[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, listOutboundActivitiesSql(accountId, limit));
    return results.flatMap((raw) => {
      const row = parseRow(OutboundActivityRowSchema, raw);
      return row.isOk() ? [row.value] : [];
    });
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

export const ensureOutboxTarget = async (
  db: D1Database,
  activityId: string,
  inboxUrl: string,
): Promise<Result<OutboxDeliveryValue, RepositoryError>> => {
  const ensured = await ensureOutboxTargets(db, activityId, [inboxUrl]);
  if (ensured.isErr()) {
    return err(ensured.error);
  }
  const loaded = await findOutboxTarget(db, activityId, inboxUrl);
  if (loaded.isErr()) {
    return err(loaded.error);
  }
  if (!loaded.value) {
    return err(toRepositoryError("outbox target missing after insert"));
  }
  return ok(loaded.value);
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
    return queryTyped(db, findOutboxTargetSql(activityId, inboxUrl));
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const raw = queried.value[0];
  if (!raw) {
    return ok(undefined);
  }
  return parseOutboxDelivery(raw);
};

export const findOutboxFanout = async (
  db: D1Database,
  activityId: string,
): Promise<Result<OutboxDeliveryValue | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped(db, findOutboxFanoutSql(activityId));
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const raw = queried.value[0];
  if (!raw) {
    return ok(undefined);
  }
  return parseOutboxDelivery(raw);
};

export const persistOutboxTarget = async (
  db: D1Database,
  activityId: string,
  inboxUrl: string,
  delivery: OutboxDeliveryValue,
): Promise<Result<void, RepositoryError>> => {
  const parsed = ActivityId.parse(activityId);
  if (parsed.isErr()) {
    return err(toRepositoryError("invalid activity id"));
  }
  return runD1(async () => {
    const columns = persistColumns(delivery);
    await runTyped(
      db,
      updateOutboxTargetSql(
        columns.kind,
        columns.reasonKind,
        columns.attemptCount,
        columns.httpStatus,
        nowIso(),
        activityId,
        inboxUrl,
      ),
    );
  });
};
