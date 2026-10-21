import { parseRows, type RepositoryError, runD1 } from "./d1";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { runTyped } from "./typed-sql";
import { newEntityId } from "./ids";
import { parseJsonColumn } from "./json-column";
import { nowIso } from "./clock";
import type { Result } from "neverthrow";
import { z } from "zod";
import { insertReport as insertReportSql } from "./generated/prisma/sql";

/** Mastodon's report categories. */
export const ReportCategorySchema = z.union([
  z.literal("spam"),
  z.literal("legal"),
  z.literal("violation"),
  z.literal("other"),
]);

export type ReportCategory = z.infer<typeof ReportCategorySchema>;

export type ReportRow = Readonly<{
  id: string;
  accountId: string;
  targetAccountId: string;
  statusIds: ReadonlyArray<string>;
  comment: string;
  category: string;
  ruleIds: ReadonlyArray<string>;
  assignedAccountId: string | null;
  actionTakenAt: string | null;
  actionTakenByAccountId: string | null;
  createdAt: string;
  updatedAt: string | null;
}>;

const ReportRowSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  target_account_id: z.string(),
  status_ids_json: z.string(),
  comment: z.string(),
  category: z.string(),
  rule_ids_json: z.string(),
  assigned_account_id: z.string().nullable(),
  action_taken_at: z.string().nullable(),
  action_taken_by_account_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

const reportFromRow = (row: z.infer<typeof ReportRowSchema>): ReportRow => ({
  id: row.id,
  accountId: row.account_id,
  targetAccountId: row.target_account_id,
  statusIds: parseJsonColumn(z.array(z.string()), row.status_ids_json).unwrapOr([]),
  comment: row.comment,
  category: row.category,
  ruleIds: parseJsonColumn(z.array(z.string()), row.rule_ids_json).unwrapOr([]),
  assignedAccountId: row.assigned_account_id,
  actionTakenAt: row.action_taken_at,
  actionTakenByAccountId: row.action_taken_by_account_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const REPORT_SELECT = `id, account_id, target_account_id, status_ids_json, comment, category,
       rule_ids_json, assigned_account_id, action_taken_at, action_taken_by_account_id, created_at, updated_at`;

export const insertReport = async (
  db: D1Database,
  input: {
    accountId: string;
    targetAccountId: string;
    statusIds: ReadonlyArray<string>;
    comment: string;
    category?: string;
    ruleIds?: ReadonlyArray<string>;
  },
): Promise<Result<{ id: string }, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    await runTyped(
      db,
      insertReportSql(
        id,
        input.accountId,
        input.targetAccountId,
        JSON.stringify(input.statusIds),
        input.comment,
        input.category ?? "other",
        JSON.stringify(input.ruleIds ?? []),
        nowIso(),
      ),
    );
    return { id };
  });

/** Mastodon's admin report filters, paged by report id. */
export type AdminReportFilters = Readonly<{
  resolved?: boolean | undefined;
  accountId?: string | undefined;
  targetAccountId?: string | undefined;
  cursor?: IdCursor | undefined;
  limit: number;
}>;

export const listReports = async (
  db: D1Database,
  filters: AdminReportFilters,
): Promise<Result<ReadonlyArray<ReportRow>, RepositoryError>> =>
  runD1(async () => {
    const conditions = ["1 = 1"];
    const binds: string[] = [];
    if (filters.resolved === true) {
      conditions.push("action_taken_at IS NOT NULL");
    }
    if (filters.resolved === false) {
      conditions.push("action_taken_at IS NULL");
    }
    if (filters.accountId) {
      conditions.push("account_id = ?");
      binds.push(filters.accountId);
    }
    if (filters.targetAccountId) {
      conditions.push("target_account_id = ?");
      binds.push(filters.targetAccountId);
    }
    const { where, order, binds: cursorBinds } = idCursorFragment(filters.cursor);
    const { results } = await db
      .prepare(
        `SELECT ${REPORT_SELECT} FROM reports
         WHERE ${conditions.join(" AND ")} ${where} ${order} LIMIT ?`,
      )
      .bind(...binds, ...cursorBinds, filters.limit)
      .all();
    return parseRows(ReportRowSchema, results).map(reportFromRow);
  });

export const findReportById = async (
  db: D1Database,
  id: string,
): Promise<Result<ReportRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(`SELECT ${REPORT_SELECT} FROM reports WHERE id = ? LIMIT 1`)
      .bind(id)
      .all();
    return parseRows(ReportRowSchema, rows.results).map(reportFromRow)[0];
  });

/** Update a report's category and the rules it is tied to. */
export const updateReport = async (
  db: D1Database,
  id: string,
  input: Readonly<{ category?: string; ruleIds?: ReadonlyArray<string> | undefined }>,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const assignments: string[] = [];
    const binds: Array<string | null> = [];
    if (input.category !== undefined) {
      assignments.push("category = ?");
      binds.push(input.category);
    }
    if (input.ruleIds !== undefined) {
      assignments.push("rule_ids_json = ?");
      binds.push(JSON.stringify(input.ruleIds));
    }
    if (assignments.length === 0) {
      return true;
    }
    assignments.push("updated_at = ?");
    binds.push(nowIso());
    const { results } = await db
      .prepare(`UPDATE reports SET ${assignments.join(", ")} WHERE id = ? RETURNING id`)
      .bind(...binds, id)
      .all();
    return (results?.length ?? 0) > 0;
  });

/** Assign a report to a moderator (`null` unassigns it). */
export const setReportAssigned = async (
  db: D1Database,
  id: string,
  accountId: string | null,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        "UPDATE reports SET assigned_account_id = ?, updated_at = ? WHERE id = ? RETURNING id",
      )
      .bind(accountId, nowIso(), id)
      .all();
    return (results?.length ?? 0) > 0;
  });

/** Ids of the open reports targeting an account, for a moderation action. */
export const listOpenReportIdsForTarget = async (
  db: D1Database,
  targetAccountId: string,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        "SELECT id FROM reports WHERE target_account_id = ? AND action_taken_at IS NULL ORDER BY id DESC",
      )
      .bind(targetAccountId)
      .all<{ id: string }>();
    return (results ?? []).map((row) => row.id);
  });

/** Resolve (`byAccountId` set) or reopen (`null`) a report. */
export const setReportResolved = async (
  db: D1Database,
  id: string,
  byAccountId: string | null,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const now = nowIso();
    const { results } = await db
      .prepare(
        `UPDATE reports SET action_taken_at = ?, action_taken_by_account_id = ?, updated_at = ?
         WHERE id = ? RETURNING id`,
      )
      .bind(byAccountId === null ? null : now, byAccountId, now, id)
      .all();
    return (results?.length ?? 0) > 0;
  });
