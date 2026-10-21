import { type RepositoryError, runD1 } from "./d1";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { queryTyped, runTyped } from "./typed-sql";
import { newEntityId } from "./ids";
import { parseJsonColumn } from "./json-column";
import { nowIso } from "./clock";
import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
  deleteFilter as deleteFilterSql,
  deleteFilterStatusById as deleteFilterStatusByIdSql,
  findFilterById as findFilterByIdSql,
  findFilterStatusById as findFilterStatusByIdSql,
  insertFilter as insertFilterSql,
  insertFilterStatus as insertFilterStatusSql,
  insertReport as insertReportSql,
  listFilters as listFiltersSql,
  listFilterStatuses as listFilterStatusesSql,
  updateFilter as updateFilterSql,
} from "./generated/prisma/sql";

export const FilterContextSchema = z.array(z.string());

export type FilterRow = {
  id: string;
  account_id: string;
  phrase: string;
  context_json: string;
  whole_word: number;
  irreversible: number;
  expires_at: string | null;
  keywords_json: string;
};

export const FilterKeywordSchema = z.object({
  id: z.string().min(1),
  keyword: z.string().min(1),
  whole_word: z.boolean(),
});

export type FilterKeyword = z.infer<typeof FilterKeywordSchema>;

const parseKeywords = schemaResult(z.array(FilterKeywordSchema));

/** Stored keywords, or a synthetic one built from the v1 `phrase`. */
export const filterKeywords = (row: FilterRow): ReadonlyArray<FilterKeyword> => {
  const parsed = parseKeywords(JSON.parse(row.keywords_json.length > 0 ? row.keywords_json : "[]"));
  if (parsed.isOk() && parsed.value.length > 0) {
    return parsed.value;
  }
  return [{ id: row.id, keyword: row.phrase, whole_word: row.whole_word === 1 }];
};

export const filterRowFrom = (raw: Record<string, unknown>): FilterRow | undefined => {
  const id = typeof raw.id === "string" ? raw.id : undefined;
  const accountId = typeof raw.account_id === "string" ? raw.account_id : undefined;
  if (!id || !accountId) {
    return undefined;
  }
  return {
    id,
    account_id: accountId,
    phrase: typeof raw.phrase === "string" ? raw.phrase : "",
    context_json: typeof raw.context_json === "string" ? raw.context_json : "[]",
    whole_word: typeof raw.whole_word === "number" ? raw.whole_word : 0,
    irreversible: typeof raw.irreversible === "number" ? raw.irreversible : 0,
    expires_at: typeof raw.expires_at === "string" ? raw.expires_at : null,
    keywords_json: typeof raw.keywords_json === "string" ? raw.keywords_json : "[]",
  };
};

const keywordsJson = (keywords: ReadonlyArray<FilterKeyword>, fallbackPhrase: string): string =>
  keywords.length > 0
    ? JSON.stringify(keywords)
    : JSON.stringify([{ id: newEntityId(), keyword: fallbackPhrase, whole_word: false }]);

export const insertFilter = async (
  db: D1Database,
  input: {
    accountId: string;
    phrase: string;
    context: ReadonlyArray<string>;
    wholeWord: boolean;
    irreversible: boolean;
    expiresAt: string | undefined;
    keywords?: ReadonlyArray<FilterKeyword>;
  },
): Promise<Result<FilterRow, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    const contextJson = JSON.stringify(input.context);
    const wholeWord = input.wholeWord ? 1 : 0;
    const irreversible = input.irreversible ? 1 : 0;
    const expiresAt = input.expiresAt ?? null;
    const keywords = keywordsJson(input.keywords ?? [], input.phrase);
    await runTyped(
      db,
      insertFilterSql(
        id,
        input.accountId,
        input.phrase,
        contextJson,
        wholeWord,
        irreversible,
        expiresAt,
        keywords,
        nowIso(),
      ),
    );
    return {
      id,
      account_id: input.accountId,
      phrase: input.phrase,
      context_json: contextJson,
      whole_word: wholeWord,
      irreversible: irreversible,
      expires_at: expiresAt,
      keywords_json: keywords,
    };
  });

export const listFilters = async (
  db: D1Database,
  accountId: string,
): Promise<Result<FilterRow[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listFiltersSql(accountId));
    return rows.flatMap((raw) => {
      const row = filterRowFrom(raw);
      return row ? [row] : [];
    });
  });

export const deleteFilter = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(db, deleteFilterSql(id, accountId));
    return rows.length > 0;
  });

export const findFilterById = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<FilterRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findFilterByIdSql(id, accountId));
    return rows[0] === undefined ? undefined : filterRowFrom(rows[0]);
  });

export const updateFilter = async (
  db: D1Database,
  accountId: string,
  id: string,
  input: {
    phrase: string;
    context: ReadonlyArray<string>;
    wholeWord: boolean;
    irreversible: boolean;
    expiresAt: string | null;
    keywords: ReadonlyArray<FilterKeyword>;
  },
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      updateFilterSql(
        id,
        accountId,
        input.phrase,
        JSON.stringify(input.context),
        input.wholeWord ? 1 : 0,
        input.irreversible ? 1 : 0,
        input.expiresAt,
        input.keywords.length > 0
          ? JSON.stringify(input.keywords)
          : JSON.stringify([{ id, keyword: input.phrase, whole_word: input.wholeWord }]),
      ),
    );
    return rows.length > 0;
  });

/** Status ids a filter is narrowed to. */
/** Mastodon's FilterStatus: one status a filter is narrowed to, with its own id. */
export type FilterStatus = Readonly<{ id: string; status_id: string }>;

export const listFilterStatuses = async (
  db: D1Database,
  filterId: string,
): Promise<Result<FilterStatus[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string | null; status_id: string }>(
      db,
      listFilterStatusesSql(filterId),
    );
    return rows.flatMap((row) => (row.id ? [{ id: row.id, status_id: row.status_id }] : []));
  });

/** Narrow a filter to a status; adding the same status again answers the existing entry. */
export const addFilterStatus = async (
  db: D1Database,
  filterId: string,
  statusId: string,
): Promise<Result<FilterStatus | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string | null; status_id: string }>(
      db,
      insertFilterStatusSql(newEntityId(), filterId, statusId, nowIso()),
    );
    const row = rows[0];
    return row?.id ? { id: row.id, status_id: row.status_id } : undefined;
  });

/** A FilterStatus by id, when it belongs to one of the account's filters. */
export const findFilterStatusById = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<FilterStatus | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string | null; status_id: string }>(
      db,
      findFilterStatusByIdSql(accountId, id),
    );
    const row = rows[0];
    return row?.id ? { id: row.id, status_id: row.status_id } : undefined;
  });

export const removeFilterStatusById = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string | null }>(
      db,
      deleteFilterStatusByIdSql(accountId, id),
    );
    return rows.length > 0;
  });

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

const reportFromRow = (row: {
  id: string;
  account_id: string;
  target_account_id: string;
  status_ids_json: string;
  comment: string;
  category: string;
  rule_ids_json: string;
  assigned_account_id: string | null;
  action_taken_at: string | null;
  action_taken_by_account_id: string | null;
  created_at: string;
  updated_at: string | null;
}): ReportRow => ({
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
    return (results ?? []).map((row) => reportFromRow(row as never));
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
    const row = rows.results?.[0];
    return row ? reportFromRow(row as never) : undefined;
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

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([FilterContextSchema]);
