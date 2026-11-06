import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { parseRows, runD1, type RepositoryError } from "./d1";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { newEntityId } from "./ids";

/** Who may quote a status, as Mastodon's `quote_approval_policy` names it. */
export const QuotePolicySchema = ["public", "followers", "nobody"] as const;
export type QuotePolicy = (typeof QuotePolicySchema)[number];

export type QuoteState = "accepted" | "revoked";

export type QuoteRow = Readonly<{
  id: string;
  statusId: string;
  quotedStatusId: string;
  state: QuoteState;
  createdAt: string;
}>;

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
  status_id: z.string(),
  quoted_status_id: z.string(),
  state: z.string(),
  created_at: z.string(),
});
const QuoteCountRow = z.object({ quoted_status_id: z.string(), count: z.number() });
const IdRow = z.object({ id: z.string() });
const QuoteEdgeRow = z.object({ status_id: z.string(), account_id: z.string() });
const PolicyRow = z.object({ policy: z.string() });
const StatusPolicyRow = z.object({ status_id: z.string(), policy: z.string() });

const toRow = (row: z.infer<typeof QuoteDbRow>): QuoteRow => ({
  id: row.id,
  statusId: row.status_id,
  quotedStatusId: row.quoted_status_id,
  state: row.state === "revoked" ? "revoked" : "accepted",
  createdAt: row.created_at,
});

const SELECT = "id, status_id, quoted_status_id, state, created_at";

/** Record the quote behind a just-published status. */
export const insertStatusQuote = async (
  db: D1Database,
  statusId: string,
  quotedStatusId: string,
  state: QuoteState = "accepted",
): Promise<Result<QuoteRow, RepositoryError>> =>
  runD1(async () => {
    const now = nowIso();
    const row: QuoteRow = {
      id: newEntityId(),
      statusId,
      quotedStatusId,
      state,
      createdAt: now,
    };
    await db
      .prepare(
        `INSERT INTO status_quotes (id, status_id, quoted_status_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, statusId, quotedStatusId, state, now, now)
      .run();
    return row;
  });

export const findQuoteByStatusId = async (
  db: D1Database,
  statusId: string,
): Promise<Result<QuoteRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(`SELECT ${SELECT} FROM status_quotes WHERE status_id = ? LIMIT 1`)
      .bind(statusId)
      .all();
    const row = parseRows(QuoteDbRow, results)[0];
    return row ? toRow(row) : undefined;
  });

/** The quote rows of several quoting statuses, keyed by quoting status id. */
export const findQuotesByStatusIds = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, QuoteRow>, RepositoryError>> =>
  runD1(async () => {
    if (statusIds.length === 0) {
      return new Map<string, QuoteRow>();
    }
    const { results } = await db
      .prepare(
        `SELECT ${SELECT} FROM status_quotes
         WHERE status_id IN (${statusIds.map(() => "?").join(", ")})`,
      )
      .bind(...statusIds)
      .all();
    return new Map(
      parseRows(QuoteDbRow, results).map((row) => {
        const quote = toRow(row);
        return [quote.statusId, quote];
      }),
    );
  });

/** How many accepted quotes each of these statuses has. */
export const quoteCountsByStatusIds = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, number>, RepositoryError>> =>
  runD1(async () => {
    if (statusIds.length === 0) {
      return new Map<string, number>();
    }
    const { results } = await db
      .prepare(
        `SELECT quoted_status_id, COUNT(*) AS count FROM status_quotes
         WHERE state = 'accepted' AND quoted_status_id IN (${statusIds.map(() => "?").join(", ")})
         GROUP BY quoted_status_id`,
      )
      .bind(...statusIds)
      .all();
    return new Map(
      parseRows(QuoteCountRow, results).map((row) => [row.quoted_status_id, Number(row.count)]),
    );
  });

/** Accepted quoting statuses of one status, newest first. */
export const listQuotingStatusIds = async (
  db: D1Database,
  quotedStatusId: string,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT s.id AS id FROM status_quotes q
         JOIN statuses s ON s.id = q.status_id
         WHERE q.quoted_status_id = ? AND q.state = 'accepted' ${where} ${order} LIMIT ?`,
      )
      .bind(quotedStatusId, ...binds, limit)
      .all();
    return parseRows(IdRow, results).map((row) => row.id);
  });

/** The authors and statuses of the accepted quotes of one status. */
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

/** Revoke one quote; only the quoted author's route calls this. */
export const revokeStatusQuote = async (
  db: D1Database,
  quotedStatusId: string,
  quotingStatusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `UPDATE status_quotes SET state = 'revoked', updated_at = ?
         WHERE quoted_status_id = ? AND status_id = ? AND state = 'accepted'
         RETURNING id`,
      )
      .bind(nowIso(), quotedStatusId, quotingStatusId)
      .all();
    return parseRows(IdRow, results).length > 0;
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
