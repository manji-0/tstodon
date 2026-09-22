import { assertNever } from "@tstodon/core";
import {
  ActivityId,
  OutboxDelivery,
  type OutboxDelivery as OutboxDeliveryValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import {
  parseRow,
  OutboundActivityRowSchema,
  OutboxDeliveryRowSchema,
  toRepositoryError,
} from "./schemas";

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
): Promise<Result<OutboundActivityRow, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    const createdAt = nowIso();
    const payloadJson = JSON.stringify(input.payload);
    await db
      .prepare(
        `INSERT INTO outbound_activities (id, account_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, input.accountId, input.kind, payloadJson, createdAt)
      .run();
    const queued = OutboxDelivery.queued();
    await db
      .prepare(
        `INSERT INTO outbox_deliveries (id, activity_id, kind, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(newEntityId(), id, queued.kind, queued.attemptCount, createdAt, createdAt)
      .run();
    return {
      id,
      account_id: input.accountId,
      kind: input.kind,
      payload_json: payloadJson,
      created_at: createdAt,
    };
  });

export const findOutboundActivity = async (
  db: D1Database,
  id: string,
): Promise<Result<OutboundActivityRow | undefined, RepositoryError>> => {
  const queried = await runD1(() =>
    db
      .prepare(
        `SELECT id, account_id, kind, payload_json, created_at FROM outbound_activities WHERE id = ?`,
      )
      .bind(id)
      .first(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return ok(undefined);
  }
  const row = parseRow(OutboundActivityRowSchema, queried.value);
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
    const { results } = await db
      .prepare(
        `SELECT id, account_id, kind, payload_json, created_at
         FROM outbound_activities WHERE account_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .bind(accountId, limit)
      .all();
    return (results ?? []).flatMap((raw) => {
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
    await db
      .prepare(
        `UPDATE outbox_deliveries
         SET kind = ?, reason_kind = ?, attempt_count = ?, http_status = ?, updated_at = ?
         WHERE activity_id = ? AND inbox_url IS NULL`,
      )
      .bind(
        columns.kind,
        columns.reasonKind,
        columns.attemptCount,
        columns.httpStatus,
        nowIso(),
        activityId,
      )
      .run();
  });
};

export const ensureOutboxTarget = async (
  db: D1Database,
  activityId: string,
  inboxUrl: string,
): Promise<Result<OutboxDeliveryValue, RepositoryError>> => {
  const parsed = ActivityId.parse(activityId);
  if (parsed.isErr()) {
    return err(toRepositoryError("invalid activity id"));
  }
  const inserted = await runD1(async () => {
    const queued = OutboxDelivery.queued();
    const createdAt = nowIso();
    await db
      .prepare(
        `INSERT OR IGNORE INTO outbox_deliveries
         (id, activity_id, kind, attempt_count, inbox_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newEntityId(),
        activityId,
        queued.kind,
        queued.attemptCount,
        inboxUrl,
        createdAt,
        createdAt,
      )
      .run();
  });
  if (inserted.isErr()) {
    return err(inserted.error);
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

export const findOutboxTarget = async (
  db: D1Database,
  activityId: string,
  inboxUrl: string,
): Promise<Result<OutboxDeliveryValue | undefined, RepositoryError>> => {
  const queried = await runD1(() =>
    db
      .prepare(
        `SELECT kind, reason_kind, attempt_count, http_status, inbox_url
         FROM outbox_deliveries WHERE activity_id = ? AND inbox_url = ?`,
      )
      .bind(activityId, inboxUrl)
      .first(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return ok(undefined);
  }
  return parseOutboxDelivery(queried.value);
};

export const findOutboxFanout = async (
  db: D1Database,
  activityId: string,
): Promise<Result<OutboxDeliveryValue | undefined, RepositoryError>> => {
  const queried = await runD1(() =>
    db
      .prepare(
        `SELECT kind, reason_kind, attempt_count, http_status, inbox_url
         FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NULL`,
      )
      .bind(activityId)
      .first(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return ok(undefined);
  }
  return parseOutboxDelivery(queried.value);
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
    await db
      .prepare(
        `UPDATE outbox_deliveries
         SET kind = ?, reason_kind = ?, attempt_count = ?, http_status = ?, updated_at = ?
         WHERE activity_id = ? AND inbox_url = ?`,
      )
      .bind(
        columns.kind,
        columns.reasonKind,
        columns.attemptCount,
        columns.httpStatus,
        nowIso(),
        activityId,
        inboxUrl,
      )
      .run();
  });
};
