import { parseRows, type RepositoryError, runD1, toRepositoryError } from "./d1";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { queryTyped } from "./typed-sql";
import { newEntityId } from "./ids";
import { parseJsonColumn } from "./json-column";
import { nowIso } from "./clock";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { RemoteAccountId } from "./remote-account-id";
import { insertReport as insertReportSql } from "./generated/prisma/sql";

/** Mastodon's report categories. */
export const ReportCategorySchema = z.union([
  z.literal("spam"),
  z.literal("legal"),
  z.literal("violation"),
  z.literal("other"),
]);

export type ReportCategory = z.infer<typeof ReportCategorySchema>;

/**
 * One side of a report: a local account, or a remote actor. A report from
 * another server (a `Flag`) has a remote reporter; a report a local user files
 * against a remote account has a remote target.
 */
export const ReportPartySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Local"), accountId: z.string().min(1) }),
  z.object({ kind: z.literal("Remote"), actorUri: z.string().min(1) }),
]);

export type ReportParty = z.infer<typeof ReportPartySchema>;

export const ReportParty = {
  schema: ReportPartySchema,
  parse: schemaResult(ReportPartySchema),
  /** The account id the API shows for the party: a local id, or `r_…` for a remote actor. */
  accountId: (party: ReportParty): string =>
    party.kind === "Local" ? party.accountId : RemoteAccountId.encode(party.actorUri),
  /** The party an API account id names. */
  ofAccountId: (id: string): ReportParty => {
    const actorUri = RemoteAccountId.decode(id);
    return actorUri.isOk()
      ? { kind: "Remote", actorUri: actorUri.value }
      : { kind: "Local", accountId: id };
  },
} as const;

export type ReportRow = Readonly<{
  id: string;
  reporter: ReportParty;
  target: ReportParty;
  statusIds: ReadonlyArray<string>;
  comment: string;
  category: string;
  ruleIds: ReadonlyArray<string>;
  assignedAccountId: string | null;
  actionTakenAt: string | null;
  actionTakenByAccountId: string | null;
  /** Whether the report was forwarded to the target's server. */
  forwarded: boolean;
  /** `user@domain` of a remote reporter / target when the report was filed; `null` for a local party. */
  reporterAcct: string | null;
  targetAcct: string | null;
  createdAt: string;
  updatedAt: string | null;
}>;

const ReportRowSchema = z.object({
  id: z.string(),
  account_id: z.string().nullable(),
  reporter_actor_uri: z.string().nullable(),
  target_account_id: z.string().nullable(),
  target_actor_uri: z.string().nullable(),
  status_ids_json: z.string(),
  comment: z.string(),
  category: z.string(),
  rule_ids_json: z.string(),
  assigned_account_id: z.string().nullable(),
  action_taken_at: z.string().nullable(),
  action_taken_by_account_id: z.string().nullable(),
  forwarded: z.number(),
  reporter_acct: z.string().nullable(),
  target_acct: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

/** The table's CHECKs keep exactly one of the two columns set. */
const partyOf = (accountId: string | null, actorUri: string | null): ReportParty =>
  accountId !== null ? { kind: "Local", accountId } : { kind: "Remote", actorUri: actorUri ?? "" };

const partyColumns = (
  party: ReportParty,
): readonly [accountId: string | null, actorUri: string | null] =>
  party.kind === "Local" ? [party.accountId, null] : [null, party.actorUri];

const reportFromRow = (row: z.infer<typeof ReportRowSchema>): ReportRow => ({
  id: row.id,
  reporter: partyOf(row.account_id, row.reporter_actor_uri),
  target: partyOf(row.target_account_id, row.target_actor_uri),
  statusIds: parseJsonColumn(z.array(z.string()), row.status_ids_json).unwrapOr([]),
  comment: row.comment,
  category: row.category,
  ruleIds: parseJsonColumn(z.array(z.string()), row.rule_ids_json).unwrapOr([]),
  assignedAccountId: row.assigned_account_id,
  actionTakenAt: row.action_taken_at,
  actionTakenByAccountId: row.action_taken_by_account_id,
  forwarded: row.forwarded !== 0,
  reporterAcct: row.reporter_acct,
  targetAcct: row.target_acct,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const REPORT_SELECT = `id, account_id, reporter_actor_uri, target_account_id, target_actor_uri,
       status_ids_json, comment, category, rule_ids_json, assigned_account_id, action_taken_at,
       action_taken_by_account_id, forwarded, reporter_acct, target_acct, created_at, updated_at`;

export type ReportInput = Readonly<{
  reporter: ReportParty;
  target: ReportParty;
  statusIds: ReadonlyArray<string>;
  comment: string;
  category?: string;
  ruleIds?: ReadonlyArray<string>;
  forwarded?: boolean;
  /** The `user@domain` handle of a remote party, kept for when the actor is purged. */
  reporterAcct?: string | undefined;
  targetAcct?: string | undefined;
}>;

/** The new report's id; `undefined` when a report for the same `Flag` exists. */
const insertReportRow = (
  db: D1Database,
  input: ReportInput,
  flagUri: string | null,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    const rows = await queryTyped<{ id: string }>(
      db,
      insertReportSql(
        id,
        ...partyColumns(input.reporter),
        ...partyColumns(input.target),
        JSON.stringify(input.statusIds),
        input.comment,
        input.category ?? "other",
        JSON.stringify(input.ruleIds ?? []),
        input.forwarded === true ? 1 : 0,
        flagUri,
        nowIso(),
        input.reporterAcct ?? null,
        input.targetAcct ?? null,
      ),
    );
    return rows.length > 0 ? id : undefined;
  });

export const insertReport = async (
  db: D1Database,
  input: ReportInput,
): Promise<Result<{ id: string }, RepositoryError>> => {
  const inserted = await insertReportRow(db, input, null);
  return inserted.andThen((id) =>
    id === undefined ? err(toRepositoryError("report was not inserted")) : ok({ id }),
  );
};

/** A report a `Flag` filed, or the one an earlier delivery of it already filed. */
export type FlagReportFiling =
  | Readonly<{ kind: "Filed"; id: string }>
  | Readonly<{ kind: "AlreadyFiled" }>;

export const insertFlagReport = async (
  db: D1Database,
  input: ReportInput & Readonly<{ flagUri: string }>,
): Promise<Result<FlagReportFiling, RepositoryError>> => {
  const inserted = await insertReportRow(db, input, input.flagUri);
  return inserted.map((id) =>
    id === undefined ? { kind: "AlreadyFiled" } : { kind: "Filed", id },
  );
};

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
      const reporter = ReportParty.ofAccountId(filters.accountId);
      conditions.push(reporter.kind === "Local" ? "account_id = ?" : "reporter_actor_uri = ?");
      binds.push(reporter.kind === "Local" ? reporter.accountId : reporter.actorUri);
    }
    if (filters.targetAccountId) {
      const target = ReportParty.ofAccountId(filters.targetAccountId);
      conditions.push(target.kind === "Local" ? "target_account_id = ?" : "target_actor_uri = ?");
      binds.push(target.kind === "Local" ? target.accountId : target.actorUri);
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

/** Ids of the open reports targeting an account or remote actor, for a moderation action. */
export const listOpenReportIdsForTarget = async (
  db: D1Database,
  target: ReportParty,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () => {
    const [column, value] =
      target.kind === "Local"
        ? ["target_account_id", target.accountId]
        : ["target_actor_uri", target.actorUri];
    const { results } = await db
      .prepare(
        `SELECT id FROM reports WHERE ${column} = ? AND action_taken_at IS NULL ORDER BY id DESC`,
      )
      .bind(value)
      .all<{ id: string }>();
    return (results ?? []).map((row) => row.id);
  });

/**
 * The `user@domain` handle some report remembers for a remote actor, for
 * naming it after the actor was purged from the cache.
 */
export const findRemoteActorAcct = async (
  db: D1Database,
  actorUri: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(
        `SELECT target_acct AS acct FROM reports WHERE target_actor_uri = ? AND target_acct IS NOT NULL
         UNION ALL
         SELECT reporter_acct AS acct FROM reports WHERE reporter_actor_uri = ? AND reporter_acct IS NOT NULL
         LIMIT 1`,
      )
      .bind(actorUri, actorUri)
      .first<{ acct: string }>();
    return row?.acct;
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
