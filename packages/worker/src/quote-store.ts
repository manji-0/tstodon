import {
  Quote,
  type QuoteState,
  type QuoteValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, parseRows, runD1, sqlInJsonEach, type RepositoryError } from "./d1";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { statusTargetColumns } from "./status-store";

/** Who may quote a status, as Mastodon's `quote_approval_policy` names it. */
export const QuotePolicySchema = ["public", "followers", "nobody"] as const;
export type QuotePolicy = (typeof QuotePolicySchema)[number];

/** Direct posts are never quotable; followers-only posts default to followers. */
export const defaultQuotePolicy = (visibility: string): QuotePolicy => {
  if (visibility === "direct") {
    return "nobody";
  }
  if (visibility === "private") {
    return "followers";
  }
  return "public";
};

export const isQuotePolicy = (raw: string): raw is QuotePolicy =>
  QuotePolicySchema.some((policy) => policy === raw);

const QuoteDbRow = z.object({
  id: z.string(),
  status_id: z.string().nullable(),
  remote_status_id: z.string().nullable(),
  quoted_status_id: z.string().nullable(),
  quoted_remote_status_id: z.string().nullable(),
  state: z.string(),
  approval_uri: z.string().nullable(),
  activity_uri: z.string().nullable(),
  created_at: z.string(),
});
const QuoteCountRow = z.object({ quoted_id: z.string(), count: z.number() });
const TargetRow = z.object({
  status_id: z.string().nullable(),
  remote_status_id: z.string().nullable(),
});
const QuoteEdgeRow = z.object({ status_id: z.string(), account_id: z.string() });
const PolicyRow = z.object({ policy: z.string() });
const StatusPolicyRow = z.object({ status_id: z.string(), policy: z.string() });

const targetOf = (local: string | null, remote: string | null) =>
  local !== null
    ? { kind: "LocalStatus", statusId: local }
    : { kind: "RemoteStatus", statusId: remote };

const stateOf = (state: string, approvalUri: string | null) => {
  switch (state) {
    case "accepted":
      return {
        kind: "Accepted",
        approval: approvalUri === null ? { kind: "Implicit" } : { kind: "Stamp", uri: approvalUri },
      };
    case "pending":
      return { kind: "Pending" };
    case "rejected":
      return { kind: "Rejected" };
    case "revoked":
      return { kind: "Revoked" };
    case "deleted":
      return { kind: "Deleted" };
    default:
      return undefined;
  }
};

/** A stored row as a quote; a row that does not parse is left out. */
const toQuote = (row: z.infer<typeof QuoteDbRow>): QuoteValue[] => {
  const quote = Quote.parse({
    id: row.id,
    quoting: targetOf(row.status_id, row.remote_status_id),
    quoted: targetOf(row.quoted_status_id, row.quoted_remote_status_id),
    state: stateOf(row.state, row.approval_uri),
    activityUri: row.activity_uri ?? undefined,
    createdAt: row.created_at,
  });
  return quote.isOk() ? [quote.value] : [];
};

const stateColumns = (state: QuoteState): readonly [state: string, approvalUri: string | null] => {
  switch (state.kind) {
    case "Accepted":
      return ["accepted", state.approval.kind === "Stamp" ? state.approval.uri : null];
    case "Pending":
      return ["pending", null];
    case "Rejected":
      return ["rejected", null];
    case "Revoked":
      return ["revoked", null];
    case "Deleted":
      return ["deleted", null];
  }
};

/** The local and the remote ids among `targets`, as two {@link sqlInJsonEach} binds. */
const targetIdBinds = (targets: ReadonlyArray<StatusTargetValue>): readonly [string, string] => [
  jsonStringArray(targets.filter((t) => t.kind === "LocalStatus").map((t) => t.statusId)),
  jsonStringArray(targets.filter((t) => t.kind === "RemoteStatus").map((t) => t.statusId)),
];

const SELECT =
  "id, status_id, remote_status_id, quoted_status_id, quoted_remote_status_id, state, approval_uri, activity_uri, created_at";

/** Record a quote. */
export const insertStatusQuote = async (
  db: D1Database,
  quote: QuoteValue,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    const [state, approvalUri] = stateColumns(quote.state);
    await db
      .prepare(
        `INSERT INTO status_quotes (id, status_id, remote_status_id, quoted_status_id,
           quoted_remote_status_id, state, approval_uri, activity_uri, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        quote.id,
        ...statusTargetColumns(quote.quoting),
        ...statusTargetColumns(quote.quoted),
        state,
        approvalUri,
        quote.activityUri ?? null,
        quote.createdAt,
        quote.createdAt,
      )
      .run();
  });

/** Write a quote's state, approval, and activity after a transition. */
export const saveQuoteState = async (
  db: D1Database,
  quote: QuoteValue,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    const [state, approvalUri] = stateColumns(quote.state);
    await db
      .prepare(
        `UPDATE status_quotes SET state = ?, approval_uri = ?, activity_uri = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(state, approvalUri, quote.activityUri ?? null, nowIso(), quote.id)
      .run();
  });

/** Forget the quote a status makes, as when its author drops the quote in an edit. */
export const deleteQuoteByQuoting = async (
  db: D1Database,
  target: StatusTargetValue,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `DELETE FROM status_quotes WHERE ${target.kind === "LocalStatus" ? "status_id" : "remote_status_id"} = ?`,
      )
      .bind(target.statusId)
      .run();
  });

/** The quotes made by several quoting statuses, keyed by quoting status id. */
export const findQuotesByQuoting = async (
  db: D1Database,
  targets: ReadonlyArray<StatusTargetValue>,
): Promise<Result<ReadonlyMap<string, QuoteValue>, RepositoryError>> =>
  runD1(async () => {
    if (targets.length === 0) {
      return new Map<string, QuoteValue>();
    }
    const { results } = await db
      .prepare(
        `SELECT ${SELECT} FROM status_quotes
         WHERE status_id ${sqlInJsonEach()} OR remote_status_id ${sqlInJsonEach()}`,
      )
      .bind(...targetIdBinds(targets))
      .all();
    return new Map(
      parseRows(QuoteDbRow, results)
        .flatMap(toQuote)
        .map((quote) => [quote.quoting.statusId, quote]),
    );
  });

/** The quote a status makes, if it quotes one. */
export const findQuoteByQuoting = async (
  db: D1Database,
  target: StatusTargetValue,
): Promise<Result<QuoteValue | undefined, RepositoryError>> =>
  (await findQuotesByQuoting(db, [target])).map((quotes) => quotes.get(target.statusId));

/** A quote by its id, as its stamp URI names it. */
export const findQuoteById = async (
  db: D1Database,
  id: string,
): Promise<Result<QuoteValue | undefined, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(`SELECT ${SELECT} FROM status_quotes WHERE id = ? LIMIT 1`)
      .bind(id)
      .all();
    return parseRows(QuoteDbRow, results).flatMap(toQuote)[0];
  });

const findQuotesWhere = async (
  db: D1Database,
  column: "activity_uri" | "approval_uri",
  value: string,
): Promise<Result<QuoteValue[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(`SELECT ${SELECT} FROM status_quotes WHERE ${column} = ? ORDER BY id`)
      .bind(value)
      .all();
    return parseRows(QuoteDbRow, results).flatMap(toQuote);
  });

/** The quote a `QuoteRequest` asked for, by the request's id. */
export const findQuoteByActivityUri = async (
  db: D1Database,
  uri: string,
): Promise<Result<QuoteValue | undefined, RepositoryError>> =>
  (await findQuotesWhere(db, "activity_uri", uri)).map((quotes) => quotes[0]);

/**
 * The quotes a remote quoted author's stamp approved, by the stamp's URI.
 * Several quotes may name one URI (as on Mastodon, it is not unique), so the
 * caller picks the one the stamp's author may answer for.
 */
export const findQuotesByApprovalUri = (
  db: D1Database,
  uri: string,
): Promise<Result<QuoteValue[], RepositoryError>> => findQuotesWhere(db, "approval_uri", uri);

/** How many accepted quotes each of these statuses has, keyed by status id. */
export const quoteCountsByQuoted = async (
  db: D1Database,
  targets: ReadonlyArray<StatusTargetValue>,
): Promise<Result<ReadonlyMap<string, number>, RepositoryError>> =>
  runD1(async () => {
    if (targets.length === 0) {
      return new Map<string, number>();
    }
    const { results } = await db
      .prepare(
        `SELECT COALESCE(quoted_status_id, quoted_remote_status_id) AS quoted_id, COUNT(*) AS count
         FROM status_quotes
         WHERE state = 'accepted'
           AND (quoted_status_id ${sqlInJsonEach()} OR quoted_remote_status_id ${sqlInJsonEach()})
         GROUP BY quoted_id`,
      )
      .bind(...targetIdBinds(targets))
      .all();
    return new Map(parseRows(QuoteCountRow, results).map((row) => [row.quoted_id, row.count]));
  });

/** The statuses that quote one status with an accepted quote, by quoting status id under the cursor. */
export const listQuotingTargets = async (
  db: D1Database,
  quoted: StatusTargetValue,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<StatusTargetValue>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT status_id, remote_status_id FROM (
           SELECT COALESCE(status_id, remote_status_id) AS id, status_id, remote_status_id
           FROM status_quotes
           WHERE ${quoted.kind === "LocalStatus" ? "quoted_status_id" : "quoted_remote_status_id"} = ?
             AND state = 'accepted'
         ) WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(quoted.statusId, ...binds, limit)
      .all();
    return parseRows(TargetRow, results).flatMap((row) => {
      const target = StatusTarget.parse(targetOf(row.status_id, row.remote_status_id));
      return target.isOk() ? [target.value] : [];
    });
  });

/** The local authors and statuses of the accepted quotes of one local status. */
export const listAcceptedQuoteEdges = async (
  db: D1Database,
  quotedStatusId: string,
): Promise<Result<ReadonlyArray<{ statusId: string; accountId: string }>, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT q.status_id AS status_id, s.account_id AS account_id
         FROM status_quotes q JOIN statuses s ON s.id = q.status_id
         WHERE q.quoted_status_id = ? AND q.state = 'accepted'`,
      )
      .bind(quotedStatusId)
      .all();
    return parseRows(QuoteEdgeRow, results).map((row) => ({
      statusId: row.status_id,
      accountId: row.account_id,
    }));
  });

/** The stored quote policy of a status, when its author set one. */
export const findStatusQuotePolicy = async (
  db: D1Database,
  statusId: string,
): Promise<Result<QuotePolicy | undefined, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare("SELECT policy FROM status_quote_policies WHERE status_id = ? LIMIT 1")
      .bind(statusId)
      .all();
    const policy = parseRows(PolicyRow, results)[0]?.policy;
    return policy !== undefined && isQuotePolicy(policy) ? policy : undefined;
  });

/** The stored quote policies of several statuses, keyed by status id. */
export const findStatusQuotePolicies = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, QuotePolicy>, RepositoryError>> =>
  runD1(async () => {
    if (statusIds.length === 0) {
      return new Map<string, QuotePolicy>();
    }
    const { results } = await db
      .prepare(
        `SELECT status_id, policy FROM status_quote_policies
         WHERE status_id IN (${statusIds.map(() => "?").join(", ")})`,
      )
      .bind(...statusIds)
      .all();
    return new Map(
      parseRows(StatusPolicyRow, results).flatMap(
        ({ status_id, policy }): [string, QuotePolicy][] =>
          isQuotePolicy(policy) ? [[status_id, policy]] : [],
      ),
    );
  });

/** Store (or replace) a status's quote policy. */
export const setStatusQuotePolicy = async (
  db: D1Database,
  statusId: string,
  policy: QuotePolicy,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO status_quote_policies (status_id, policy) VALUES (?, ?)
         ON CONFLICT(status_id) DO UPDATE SET policy = excluded.policy`,
      )
      .bind(statusId, policy)
      .run();
  });
