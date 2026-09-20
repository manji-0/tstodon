import { ActivityId, OutboxDelivery } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { parseRow, OutboundActivityRowSchema, toRepositoryError } from "./schemas";

export type OutboundActivityRow = z.infer<typeof OutboundActivityRowSchema>;

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
    await db
      .prepare(
        `UPDATE outbox_deliveries SET kind = ?, reason_kind = NULL, updated_at = ? WHERE activity_id = ?`,
      )
      .bind(next.kind, nowIso(), activityId)
      .run();
  });
};
