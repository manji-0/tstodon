import { warmSchemas } from "@tstodon/core";
import {
  DeadOutboxJob,
  type DeadOutboxJobEntry,
  type DeadOutboxJobRow,
  type DeadOutboxJobSelection,
} from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { parseJsonText } from "./json-column";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  deleteDeadOutboxJobs as deleteDeadOutboxJobsSql,
  listDeadOutboxJobs as listDeadOutboxJobsSql,
  upsertDeadOutboxJob as upsertDeadOutboxJobSql,
} from "./generated/prisma/sql";

const DeadOutboxJobRowSchema = z.object({ id: z.string().min(1), body_json: z.string() });

/** The stored text of a message body: its JSON, or its string form when it has none. */
const bodyJsonOf = (body: unknown): string => {
  try {
    return JSON.stringify(body) ?? "null";
  } catch {
    return JSON.stringify(String(body));
  }
};

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The row id of a dead job: the SHA-256 of its stored body, so a repeat lands on the same row. */
export const deadOutboxJobId = async (body: unknown): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyJsonOf(body))));

const upsertDeadOutboxJob = (id: string, entry: DeadOutboxJobEntry, seenAt: string) =>
  upsertDeadOutboxJobSql(
    id,
    entry.jobKind,
    entry.reason.kind,
    bodyJsonOf(entry.body),
    entry.attempts,
    DeadOutboxJob.describe(entry),
    seenAt,
  );

/** Store a dead job, or count it again on its row. Resolves to the row id. */
export const recordDeadOutboxJob = async (
  db: D1Database,
  entry: DeadOutboxJobEntry,
  seenAt: string,
): Promise<Result<string, RepositoryError>> => {
  const id = await deadOutboxJobId(entry.body);
  const recorded = await runD1(() => runTyped(db, upsertDeadOutboxJob(id, entry, seenAt)));
  return recorded.map(() => id);
};

/**
 * {@link recordDeadOutboxJob} for several jobs in one batch, which stores all
 * of them or none. Resolves to their row ids, in order.
 */
export const recordDeadOutboxJobs = async (
  db: D1Database,
  entries: ReadonlyArray<DeadOutboxJobEntry>,
  seenAt: string,
): Promise<Result<string[], RepositoryError>> => {
  const rows = await Promise.all(
    entries.map(async (entry) => ({ id: await deadOutboxJobId(entry.body), entry })),
  );
  const recorded = await runD1(() =>
    db.batch(
      rows.map(({ id, entry }) => d1PrepareTyped(db, upsertDeadOutboxJob(id, entry, seenAt))),
    ),
  );
  return recorded.map(() => rows.map(({ id }) => id));
};

export const listDeadOutboxJobs = async (
  db: D1Database,
  select: DeadOutboxJobSelection,
  seenBefore: string,
  limit: number,
): Promise<Result<ReadonlyArray<DeadOutboxJobRow>, RepositoryError>> => {
  const listed = await runD1(() =>
    queryTyped(
      db,
      listDeadOutboxJobsSql(
        seenBefore,
        select.kind,
        select.kind === "JobKind" ? select.jobKind : "",
        jsonStringArray(select.kind === "Ids" ? select.ids : []),
        limit,
      ),
      DeadOutboxJobRowSchema,
    ),
  );
  // A body stored as text that is not JSON goes back as that text.
  return listed.map((rows) =>
    rows.map((row) => {
      const parsed = parseJsonText(row.body_json);
      return { id: row.id, body: parsed.isOk() ? parsed.value : row.body_json };
    }),
  );
};

export const deleteDeadOutboxJobs = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> =>
  ids.length === 0
    ? ok(undefined)
    : runD1(async () => {
        await runTyped(db, deleteDeadOutboxJobsSql(jsonStringArray(ids)));
      });

warmSchemas([DeadOutboxJobRowSchema]);
