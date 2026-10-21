import { parseJsonColumn } from "./json-column";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { newEntityId } from "./ids";

/** The validated params of a scheduled post, replayed by the publisher. */
export const ScheduledStatusParamsSchema = z.object({
  text: z.string(),
  visibility: z.string().min(1),
  spoiler_text: z.string(),
  sensitive: z.boolean(),
  language: z.string().nullable(),
  media_ids: z.array(z.string()),
  media_attributes: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().optional(),
      focus: z.string().optional(),
    }),
  ),
  poll: z
    .object({
      options: z.array(z.string()),
      expires_in: z.number(),
      multiple: z.boolean(),
      hide_totals: z.boolean(),
    })
    .nullable(),
  in_reply_to_id: z.string().nullable(),
  quote_policy: z.string().nullable().optional(),
});

export type ScheduledStatusParams = z.infer<typeof ScheduledStatusParamsSchema>;

export type ScheduledStatusRow = Readonly<{
  id: string;
  accountId: string;
  scheduledAt: string;
  params: ScheduledStatusParams;
  createdAt: string;
}>;

/** Mastodon requires a scheduled post to be at least five minutes away. */
export const MIN_SCHEDULE_OFFSET_MS = 5 * 60 * 1000;

const rowFromRow = (row: {
  id: string;
  account_id: string;
  params_json: string;
  scheduled_at: string;
  created_at: string;
}): ScheduledStatusRow | undefined => {
  const params = parseJsonColumn(ScheduledStatusParamsSchema, row.params_json);
  if (params.isErr()) {
    return undefined;
  }
  return {
    id: row.id,
    accountId: row.account_id,
    scheduledAt: row.scheduled_at,
    params: params.value,
    createdAt: row.created_at,
  };
};

const SELECT = "id, account_id, params_json, scheduled_at, created_at";

export const insertScheduledStatus = async (
  db: D1Database,
  input: Readonly<{
    accountId: string;
    params: ScheduledStatusParams;
    scheduledAt: string;
  }>,
): Promise<Result<ScheduledStatusRow, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO scheduled_statuses (id, account_id, params_json, scheduled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.accountId, JSON.stringify(input.params), input.scheduledAt, now, now)
      .run();
    return {
      id,
      accountId: input.accountId,
      scheduledAt: input.scheduledAt,
      params: input.params,
      createdAt: now,
    };
  });

export const listScheduledStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<ScheduledStatusRow>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const rows = await db
      .prepare(
        `SELECT ${SELECT} FROM scheduled_statuses
         WHERE account_id = ? ${where} ${order} LIMIT ?`,
      )
      .bind(accountId, ...binds, limit)
      .all();
    return (rows.results ?? []).flatMap((row) => {
      const parsed = rowFromRow(row as never);
      return parsed ? [parsed] : [];
    });
  });

export const findScheduledStatus = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<ScheduledStatusRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(`SELECT ${SELECT} FROM scheduled_statuses WHERE account_id = ? AND id = ? LIMIT 1`)
      .bind(accountId, id)
      .all();
    const row = rows.results?.[0];
    return row ? rowFromRow(row as never) : undefined;
  });

export const updateScheduledStatusAt = async (
  db: D1Database,
  accountId: string,
  id: string,
  scheduledAt: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(
        "UPDATE scheduled_statuses SET scheduled_at = ?, updated_at = ? WHERE account_id = ? AND id = ? RETURNING id",
      )
      .bind(scheduledAt, nowIso(), accountId, id)
      .all();
    return (rows.results?.length ?? 0) > 0;
  });

export const deleteScheduledStatus = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare("DELETE FROM scheduled_statuses WHERE account_id = ? AND id = ? RETURNING id")
      .bind(accountId, id)
      .all();
    return (rows.results?.length ?? 0) > 0;
  });

/** Posts whose time has come, oldest first, across all accounts. */
export const listDueScheduledStatuses = async (
  db: D1Database,
  now: string,
  limit: number,
): Promise<Result<ReadonlyArray<ScheduledStatusRow>, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT ${SELECT} FROM scheduled_statuses WHERE scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT ?`,
      )
      .bind(now, limit)
      .all();
    return (rows.results ?? []).flatMap((row) => {
      const parsed = rowFromRow(row as never);
      return parsed ? [parsed] : [];
    });
  });

/** The ScheduledStatus document Mastodon returns for a scheduled post. */
export const scheduledStatusDocument = (
  row: ScheduledStatusRow,
  media: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> => ({
  id: row.id,
  scheduled_at: row.scheduledAt,
  params: {
    text: row.params.text,
    media_ids: row.params.media_ids.length > 0 ? [...row.params.media_ids] : null,
    sensitive: row.params.sensitive,
    spoiler_text: row.params.spoiler_text.length > 0 ? row.params.spoiler_text : null,
    visibility: row.params.visibility,
    language: row.params.language,
    scheduled_at: null,
    poll: row.params.poll
      ? {
          options: [...row.params.poll.options],
          expires_in: row.params.poll.expires_in,
          multiple: row.params.poll.multiple,
          hide_totals: row.params.poll.hide_totals,
        }
      : null,
    idempotency: null,
    with_rate_limit: false,
    in_reply_to_id: row.params.in_reply_to_id,
    application_id: null,
  },
  media_attachments: [...media],
});
